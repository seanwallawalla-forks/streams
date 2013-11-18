# Streams API Requirements

Drawing upon the JavaScript community's extensive experience with streaming primitives, we list these scenarios that must be solved within the scope of a complete stream abstraction.

## Background Reading

The most clear and insightful commentary on a streams API has so far been produced by Isaac Schlueter, lead Node.js maintainer. In a series of posts on the public-webapps list, he outlined his thoughts, first [on the general concepts and requirements of a streams API](http://lists.w3.org/Archives/Public/public-webapps/2013JulSep/0275.html), and second [on potential specific API details and considerations](http://lists.w3.org/Archives/Public/public-webapps/2013JulSep/0355.html). This document leans heavily on his conceptual analysis.

To understand the importance of backpressure, watch [Thorsten Lorenz's LXJS 2013 talk](https://www.youtube.com/watch?v=9llfAByho98) and perhaps play with his [stream-viz](http://thlorenz.github.io/stream-viz/) demo.

## Creating Readable Streams

### You must be able to efficiently adapt existing _push_-based data sources into a uniform streaming interface.

A _push-based_ data source is one which, while the flow is turned on, pushes data at you (e.g. via events). It may also provide a mechanism for pausing and resuming the flow of data. However, this mechanism could be advisory, i.e. you may still receive data after requesting a pause. It is important not to lose such data (it must be buffered).

An example of a push-based data source is a TCP socket. (TODO: someone who knows TCP better explain exactly the way in which it pushes data, and what "pausing" means in that context and why it is advisory.)

In general, a push-based data source can be modeled as:

- A `readStart` method that starts the flow of data
- A `readStop` method that sends an advisory signal to stop the flow of data
- A `ondata` handler that fires when new data is pushed from the source
- A `onend` handler that fires when the source has no more data
- A `onerror` handler that fires when the source signals an error getting data

### You must be able to efficiently adapt existing _pull_-based data sources into a uniform streaming interface.

A _pull-based_ data source is one which you must request data from. The data may be available synchronously, or asynchronously. It is important not to let this [zalgo-esque](http://blog.izs.me/post/59142742143/designing-apis-for-asynchrony) implementation detail leak into the semantics of the uniform stream API, but at the same time, it is preferable not to impose a delay on consumers if the data is available synchronously.

An example of a pull-based data source is a file descriptor. (TODO: someone explain how this maps to C-level APIs.)

In general, a pull-based data source can be modeled as:

- An `open(cb)` method that gains access to the source; it can call `cb` either synchronous or asynchronously, with either `(err)` or `(null)`.
- A `read(cb)` function method that gets data from the source; can call `cb` either synchronously or asynchronously, with either `(err, null, null)` or `(null, true, null)` indicating there is no more data or `(null, false, data)` indicating there is data.
- A `close()` method that releases access to the source (necessary to call only if all data has not already been read).

TODO: is this an accurate model? Should `close` be async/error-prone too?

### You must not lose data.

A common problem with push-based data sources is that they make it very easy to lose data if you do not immediately process it.

For example, Node.js's "streams1" (version 0.6 and below) presented a push-based API that mapped directly to the underlying data source. So a stream for incoming HTTP POST request data would fire `"data"` events continually. A common problem was the desire to perform some asynchronous action, such as authentication, before consuming the stream. But while this asynchronous authentication was taking place, data events would be fired and lost. Worse, calling `pause()` on the request stream did not work, because the pause mapped directly to the underlying TCP primitive, which is only advisory. This forced authors to manually buffer incoming requests, which was easy to do incorrectly or inefficiently.

The solution is to move the buffering logic into the stream primitive itself, removing the error-prone and easy-to-forget process it forces upon consumers. If you stop there, you end up with a push stream with  `pause()` and `resume()` methods that are not advisory, but instead reliably stop the flow of `"data"`, `"end"`, and `"close"` events. However, you can take this further, and use your internal buffer to unify both push- and pull-based data sources into a single pull-based streaming API.

### You must not force an asynchronous reading API upon users.

Data is often available synchronously, for example because it has been previously buffered into memory, or cached by the OS, or because it is being passed through a synchronous transform stream. Thus, even though the most natural mental model may consist of asynchronously pulling data or waiting for it to arrive, enforcing this upon consumers of the readable stream interface would be a mistake, as it prevents them from accessing the data as fast as possible, and imposes an unnecessary delay for every step along a stream chain.

A better model is to provide synchronous access to already-available data, plus the ability to install a handler to be called asynchronously when more data becomes available. A consumer then consults a state property of the readable stream, which tells them whether synchronously reading will be successful, or whether they should install an asynchronous handler to read later.

## Creating Writable Streams

### You must shield the user from the complexity of buffering sequential writes.

Most underlying data sinks are designed to work well with only one concurrent write. For example, while asynchronously writing to an open file descriptor, you should not perform another write until the first finishes. (TODO: give more low-level examples of e.g. how the filesystem or network barfs at you or causes out-of-order delivery.) Moreover, you generally need to make sure that the previous writes finish *successfully* before writing the next piece of data.

On the other hand, incoming data, either produced manually or piped from a readable stream, has no respect for the limits of the underlying sink. If you are piping from a fast filesystem to a slow network connection, it is quite likely new data will be available from the filesystem before the network responds that it has successfully delivered the first chunk you wrote to it. Forcing users of your writable stream API to juggle this state is an undue and error-prone burden. Worse, users can sometimes get away with ignoring this concern, e.g. if they usually pipe a slow source to a fast one, there will be no problems, until one day they pipe to a network filesystem instead of a local one, and writes are suddenly delivered concurrently or out of order.

Thus it is the duty of a writable stream API to provide an easy interface for writing data to it at any speed, but buffering incoming data and only forwarding it to the underlying sink one chunk at a time, and only after the previous write completed successfully.

This leads to a natural quantification of how "slow" a writable stream is in terms of how full its write buffer is. This measure of slowness can be used to propagate backpressure signals to anyone writing data to the writable stream; see below for more details.

### You must not force an asynchronous writing API upon users.

Again, it is often possible to perform a synchronous write, e.g. to an in-memory data source or to a synchronous transformation. Thus, the user must not be forced to wait for a previous write to complete before continuing to write.

This issue is actually solved by properly considering the previous one; they are two facets of the same thing. If you buffer sequential writes for the user, they can synchronously write chunks with impunity.

Note that it is not important to *notify* the user synchronously of success or failure when writing (even if the write happened synchronously). It is simply important to not require them to *wait* for an asynchronous notification before continuing to write.

### You must provide a means of performing batch writes without introducing lag in the normal case.

It is common to perform multiple write operations quickly and in sequence, for example writing HTTP request headers and then writing the body. There is an underlying syscall, `writev`, which allows writing a vector of data instead of a single chunk of data. A performant writable stream API must provide a way to use this syscall.

A way of doing so, while sacrificing performance for the normal (non-vector) case, is to wait until the end of a tick, and aggregate all writes within that tick into a `writev` call. But this introduces unacceptable lag for a low-level stream API, as it means that upon performing a normal write, you cannot immediately forward that write to the underlying sink, but instead must wait until the end of the tick.

Instead, it is best to provide some kind of explicit hint via the writable stream API that you intend to perform multiple write operation in succession. An approach familiar to network programmers is the "cork-uncork" paradigm, where you "cork" the stream, perform some writes, then uncork it, flushing all the writes with a single `writev` call upon uncorking. There are various other possibilities, with varying degrees of usability; a relevant discussion can be found [in the context of Node.js's introduction of these primitives](https://groups.google.com/d/msg/nodejs/UNWhF64KeQI/zN2VCWYkMhcJ).

### You must provide a way to signal a close of the underlying resource.

When all data has been successfully written to the stream, users of the writable stream API will want to signal that the underlying sink should be closed. For example, the underlying socket connection should be freed back to the connection pool, or the file descriptor should be closed.


## Composing Streams

### You must be able to pipe streams to each other.

The primary way of consuming streams is to pipe them to each other. This is the essence of streaming APIs: getting data from a readable stream to a writable one, while buffering as little data as possible in memory.

```js
fs.createReadStream("source.txt")
    .pipe(fs.createWriteStream("dest.txt"));

http.get("http://example.com")
    .pipe(fs.createWriteStream("dest.txt"));
```

### You must be able to transform streams via the pipe chain.

A naturally-arising concept is a *transform stream*, i.e. a stream that is both readable and writable, such that when data is written to it, transformed data is written out the other side. Note that the transform is rarely one-to-one; for example a compression algorithm can be represented as a transform stream that reads much more than it writes.

```js
fs.createReadStream("source.zip")
    .pipe(zlib.createGzipDecompressor(options))
    .pipe(fs.createWriteStream("dest/"));

fs.createReadStream("index.html")
    .pipe(zlib.createGzipCompressor(options))
    .pipe(httpServerResponse);

http.get("http://example.com/video.mp4")
    .pipe(videoProcessingWebWorker)
    .pipe(document.query("video"));

fs.createReadStream("source.txt")
    .pipe(new StringDecoder("utf-8"))
    .pipe(database1.queryExecutor)
    .pipe(database2.tableWriter("table"));
```

_NOTE: a transform stream is not always the most efficient or straightforward abstraction, although it may fit nicely into a pipe chain. For example, the `StringDecoder` transform above is a synchronous transformation, and the transform stream machinery is possibly overkill. A simpler approach might be a simple function that takes a readable stream of `ArrayBuffer`s and returns a readable stream of strings, by wrapping the appropriate methods to synchronous transformation._

### You must be able to communicate backpressure.

_Backpressure_ is roughly the act of letting the slowest writable stream in the chain govern the rate at which data is consumed from the ultimate data source. This is necessary to make sure a program has a reasonable upper bound on memory usage as it buffers to prevent losing data. Without backpressure, slow writable streams in the chain will either cause memory usage to balloon as buffered data grows without limit, or will cause data loss if the buffers are capped at a hard limit.

If this data source is pull-based, this means not pulling data any faster than required; if the data source is push-based, this means issuing a pause signal when too much data has already been pushed but not yet flushed through the stream chain.

The exact strategy for applying backpressure can be a quite subtle matter, and will depend on whether you want your stream API to present a pull- or push-based interface. Assuming a pull-based stream interface, the most naïve backpressure strategy is:

- _When the stream is based on a pull source:_
  - When a consumer signals it is ready to read data from the stream object, pull data from the source into the stream's internal buffer so that it can be read.
  - Never load data into the stream from the source before the user signals interest.
- _When the stream is based on a push source:_
  - When a consumer signals it is ready to read data from the stream object, send a start signal to the source.
  - Once the data arrives, store it in the stream's internal buffer so it can be read, and send a stop signal to the source.

These strategies are enough for a generic case, but performance wins can be had by allowing some in-memory buffering, limited by a specified *high water mark*. This more advanced strategy consists of:

- _When the stream is based on a pull source:_
  - Proactively pull data from the source into the stream's internal buffer, even before the consumer signals that it wants to read from the stream object.
  - Do so until the pulled data accumulates up to the stream's high water mark. This makes the data available immediately when requested by consumers of the stream.
  - After the consumer reads all of the data from the internal buffer, we say that the buffer is drained; in this event, go back to proactively pulling data into the buffer from the source.
- _When the stream is based on a push source:_
  - Send a start signal to the source immediately, even before the consumer signals that it wants to read from the stream object.
  - As data is pushed from the source, accumulate it in the stream's internal buffer, up to the high water mark. Once the high  water mark is reached, send a stop signal to the source.
  - After the stream's buffer is drained, send a start signal to the source.

You can introduce an even more advanced strategy by adding a *low water mark*, which modifies the above by resuming data collection once the buffer reaches the low water mark instead of once the buffer is entirely drained.

### You must be able to pipe a stream to more than one writable stream.

Many use cases requiring piping a stream to more than one destination, e.g. a HTTP response both to a user and to a disk cache, or a stream of video data both to the local user and across an HTTP connection.

The simplest way to implement this is by introducing a "tee" duplex stream, such that writing to it writes to two separate destination streams. Then, piping to two writable streams is done by piping to a tee stream wrapping those two. However, requiring users to remember this can be a footgun, and it may be advisable to automatically create a tee stream for them.

The tee stream can use a number of strategies to govern how the speed of its outputs affect the backpressure signals it gives off, but the simplest strategy is to pass aggregate backpressure signals directly up the chain, thus letting the speed of the slowest output determine the speed of the tee.

### You must be able to communicate "abort" signals up a pipe chain.

It's common for a destination to become unable to consume any more data, either because of an error or because of a loss of interest. For example, a user may click on a link to the next video while the previous video is still streaming into the browser, or a connection to a HTTP server may be closed unexpectedly in the middle of streaming down the response data. (In general, any error writing to a writable stream should trigger an abort in any readable stream piped to it.) More benignly, there are cases when you want only a subset of a stream, e.g. when you are doing a streaming parse of a file looking for a certain signal; once you find it, you no longer care about the rest of the stream.

All of these cases call for some uniform way to signal to the readable stream that the consumer is no longer interested in its data. If the underlying data source is push-based, this means sending a pause signal and throwing away any data that continues to come in; if it is pull-based, this means reading no more data. In both cases, underlying resources like sockets or file descriptors can be cleaned up.

It's important to allow this abort signal to come from anywhere along the chain, since the closer you get to the ultimate consumer, the more knowledge is available to know when or whether it is appropriate to abort. As such, this abort must propagate backward in the chain until it reaches the ultimate producer, stopping any intermediate processing along the way.

Also note that the handling of abort signals alongside multi-stream piping must be done with care. In the tee-stream strategy discussed above, the correct thing to do would be for the tee stream to accumulate failure or abort signals from both of its outputs, and only send that upstream once both outputs have signaled they desire an upstream abort.

### You must be able to communicate "dispose" signals down a pipe chain.

As a dual to the abort use case, it's possible for a source to be unable to produce any more data, usually because of an error. In this case, any writable streams it is being piped to should not leave their underlying sinks open indefinitely; instead, they should be given a "dispose" signal.

This signal is similar to, but different than, the "close" signal described above. It implies that the data written so far is not meaningful or valid; that any buffered writes should be discarded; and that a cleanup operation should be performed. For example, when a file stream represents a newly-created file, a close signal waits for all buffered writes to complete, then closes the file descriptor; a new, complete file now exists on the disk. But a dispose signal would throw away any buffered writes and delete the file.

## Other

### The stream API should be agnostic to what type of data is being streamed.

Although underlying sources and sinks will often produce or accept only binary data, this should not prevent writing streams that contain other types of data, for example strings, objects, or frames of video. Such streams are extremely useful for programmers, both for direct consumption (consuming a string stream or stream of parsed objects is more useful than consuming `ArrayBuffer`s directly), and for producing composable transform streams.

By ensuring the stream API is agnostic to the type of data that the stream contains, it is possible to create streams for such disparate objects as HTML elements, database records, RPC messages, semantic events from remote systems, synchronization deltas for CRDTs, and user input events. By allowing all such streams to be composed together with a single uniform interface, you allow complex systems to be built while still benefiting from all of the features that streams manage for you, such as automatic backpressure, buffering, and abort or dispose signals.

This poses challenges, mainly regarding the buffering strategy for applying backpressure when it is unclear how much memory a piece of streaming data might take up. This is largely stream-specific, and the best you can do is make it easy for user-created streams to inform the implementation of relevant data, and provide a few useful defaults like a byte counter for `ArrayBuffer`s, a character counter for strings, or a generic object counter for most others. But compared to an implementation that restricts itself to a few binary or string data types, it provides a much more useful, extensible, and forward-thinking abstraction.

### You must be able to create representions of "duplex" data sources.

A common I/O abstraction is a data source that is both readable and writable, but the input and output are not related. For example, communication along a TCP socket connection can be bidirectional, but in general the data you read form the socket is not governed by the data you write to it.

One way enable this concept is to allow readable and writable stream interfaces to both be implemented, by ensuring they do not overlap (e.g. don't both have a `"state"` property or `"error"` event). Thus these duplex interfaces are simple streams that are both readable and writable, so e.g. you would be able to do both `socket.read()` and `socket.write(data)`.

Another way is to demand that such duplex interfaces represent their readable and writable streams separately, e.g. via `in` and `out` properties. In this case you would do `socket.in.read()` and `socket.out.write(data)`. This may feel more awkward for certain cases (like a TCP socket), but more natural in others (like a terminal, which traditionally has both stdout and stdin). It also has the advantage of allowing you to hand out the readable interface without granting write access, or vice-versa.

### You must have a simple way to determine when a stream is "over".

For a readable stream, this means that all data has been read from the underlying source, or that an error was encountered reading and the stream is now in an error state. For a writable stream, this means that all data has been written to the underlying sink, or that an error was encountered writing and the stream is now in an error state. This provides a convenient hook for observers to perform any relevant notifications, actions, or cleanups.

Note that this type of occurrence, which happens exactly once, either succeeds or fails, and is convenient to be able to subscribe to at any time (even if it has already occurred), fits perfectly with promises, as opposed to e.g. events.

### You must have a way of passively watching data pass through a stream.

This is commonly used for analytics or progress reporting. You wish to observe data flowing, either from a readable stream or to a writable stream, but not interfere with the flow, backpressure, or buffering strategy in any way.

A convenient interface for this is an evented one. However, marrying an evented API to a stream API presents many problems, and was widely considered a huge mistake by the Node.js core team. (For example, there are now two sources of truth about what data stream holds, and since traditional event emitters allow anyone to emit events on them, the second one is unreliable.) A better strategy may be using AOP-style "wrapping" of `read` or `write` calls to notify a separately-managed event emitter.
