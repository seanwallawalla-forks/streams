var test = require('tape');

import ReadableStream from '../lib/readable-stream';
import RandomPushSource from './utils/random-push-source';
import readableStreamToArray from './utils/readable-stream-to-array';
import sequentialReadableStream from './utils/sequential-rs';

test('ReadableStream can be constructed with no arguments', t => {
  t.plan(1);
  t.doesNotThrow(() => new ReadableStream(), 'ReadableStream constructed with no errors');
});

test('ReadableStream instances have the correct methods and properties', t => {
  t.plan(8);

  var rs = new ReadableStream();

  t.equal(typeof rs.read, 'function', 'has a read method');
  t.equal(typeof rs.wait, 'function', 'has a wait method');
  t.equal(typeof rs.cancel, 'function', 'has an cancel method');
  t.equal(typeof rs.pipeTo, 'function', 'has a pipeTo method');
  t.equal(typeof rs.pipeThrough, 'function', 'has a pipeThrough method');

  t.equal(rs.state, 'waiting', 'state starts out waiting');

  t.ok(rs.closed, 'has a closed property');
  t.ok(rs.closed.then, 'closed property is thenable');
});

test(`ReadableStream closing puts the stream in a closed state, fulfilling the wait() and closed promises with
 undefined`, t => {
  t.plan(3);

  var rs = new ReadableStream({
    start(enqueue, close) {
      close();
    }
  });

  t.equal(rs.state, 'closed', 'The stream should be in closed state');

  rs.wait().then(
    v => t.equal(v, undefined, 'wait() should return a promise resolved with undefined'),
    () => t.fail('wait() should not return a rejected promise')
  );

  rs.closed.then(
    v => t.equal(v, undefined, 'closed should return a promise resolved with undefined'),
    () => t.fail('closed should not return a rejected promise')
  );
});

test('ReadableStream reading a closed stream throws a TypeError', t => {
  t.plan(1);

  var rs = new ReadableStream({
    start(enqueue, close) {
      close();
    }
  });

  t.throws(() => rs.read(), TypeError);
});

test(`ReadableStream reading a stream makes wait() and closed return a promise resolved with undefined when the stream
 is fully drained`, t => {
  t.plan(6);

  var rs = new ReadableStream({
    start(enqueue, close) {
      enqueue('test');
      close();
    }
  });

  t.equal(rs.state, 'readable', 'The stream should be in readable state');
  t.equal(rs.read(), 'test', 'A test string should be read');
  t.equal(rs.state, 'closed', 'The stream should be in closed state');

  t.throws(() => rs.read(), TypeError);

  rs.wait().then(
    v => t.equal(v, undefined, 'wait() should return a promise resolved with undefined'),
    () => t.fail('wait() should not return a rejected promise')
  );

  rs.closed.then(
    v => t.equal(v, undefined, 'closed should return a promise resolved with undefined'),
    () => t.fail('closed should not return a rejected promise')
  );
});

test('ReadableStream avoid redundant pull call', t => {
  var pullCount = 0;
  var rs = new ReadableStream({
    pull() {
      pullCount++;
    },

    cancel() {
      t.fail('cancel should not be called');
    }
  });

  rs.wait();
  rs.wait();
  rs.wait();

  // Use setTimeout to ensure we run after any promises.
  setTimeout(() => {
    t.equal(pullCount, 1, 'pull should not be called more than once');
    t.end();
  }, 50);
});

test('ReadableStream start throws an error', t => {
  t.plan(1);

  var error = new Error('aaaugh!!');

  t.throws(
    () => new ReadableStream({ start() { throw error; } }),
    caught => t.equal(caught, error, 'error was allowed to propagate')
  );
});

test('ReadableStream pull throws an error', t => {
  t.plan(4);

  var error = new Error('aaaugh!!');
  var rs = new ReadableStream({ pull() { throw error; } });

  rs.wait().then(() => {
    t.fail('waiting should fail');
    t.end();
  });

  rs.closed.then(() => {
    t.fail('the stream should not close successfully');
    t.end();
  });

  rs.wait().catch(caught => {
    t.equal(rs.state, 'errored', 'state is "errored" after waiting');
    t.equal(caught, error, 'error was passed through as rejection of wait() call');
  });

  rs.closed.catch(caught => {
    t.equal(rs.state, 'errored', 'state is "errored" in closed catch');
    t.equal(caught, error, 'error was passed through as rejection reason of closed property');
  });
});

test('ReadableStream adapting a push source', t => {
  var pullChecked = false;
  var randomSource = new RandomPushSource(8);

  var rs = new ReadableStream({
    start(enqueue, close, error) {
      t.equal(typeof enqueue,  'function', 'enqueue is a function in start');
      t.equal(typeof close, 'function', 'close is a function in start');
      t.equal(typeof error, 'function', 'error is a function in start');

      randomSource.ondata = chunk => {
        if (!enqueue(chunk)) {
          randomSource.readStop();
        }
      };

      randomSource.onend = close;
      randomSource.onerror = error;
    },

    pull(enqueue, close, error) {
      if (!pullChecked) {
        pullChecked = true;
        t.equal(typeof enqueue, 'function', 'enqueue is a function in pull');
        t.equal(typeof close, 'function', 'close is a function in pull');
        t.equal(typeof error, 'function', 'error is a function in pull');
      }

      randomSource.readStart();
    }
  });

  readableStreamToArray(rs).then(chunks => {
    t.equal(rs.state, 'closed', 'should be closed');
    t.equal(chunks.length, 8, 'got the expected 8 chunks');
    for (var i = 0; i < chunks.length; i++) {
      t.equal(chunks[i].length, 128, 'each chunk has 128 bytes');
    }

    t.end();
  });
});

test('ReadableStream adapting a sync pull source', t => {
  var rs = sequentialReadableStream(10);

  readableStreamToArray(rs).then(chunks => {
    t.equal(rs.state, 'closed', 'stream should be closed');
    t.equal(rs.source.closed, true, 'source should be closed');
    t.deepEqual(chunks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'got the expected 10 chunks');

    t.end();
  });
});

test('ReadableStream adapting an async pull source', t => {
  var rs = sequentialReadableStream(10, { async: true });

  readableStreamToArray(rs).then(chunks => {
    t.equal(rs.state, 'closed', 'stream should be closed');
    t.equal(rs.source.closed, true, 'source should be closed');
    t.deepEqual(chunks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'got the expected 10 chunks');

    t.end();
  });
});

test('ReadableStream canceling an infinite stream', t => {
  var randomSource = new RandomPushSource();

  var cancelationFinished = false;
  var rs = new ReadableStream({
    start(enqueue, close, error) {
      randomSource.ondata = enqueue;
      randomSource.onend = close;
      randomSource.onerror = error;
    },

    pull() {
      randomSource.readStart();
    },

    cancel() {
      randomSource.readStop();
      randomSource.onend();

      return new Promise(resolve => setTimeout(() => {
        cancelationFinished = true;
        resolve();
      }, 50));
    }
  });

  readableStreamToArray(rs).then(
    storage => {
      t.equal(rs.state, 'closed', 'stream should be closed');
      t.equal(cancelationFinished, false, 'it did not wait for the cancellation process to finish before closing');
      t.ok(storage.length > 0, 'should have gotten some data written through the pipe');
      for (var i = 0; i < storage.length; i++) {
        t.equal(storage[i].length, 128, 'each chunk has 128 bytes');
      }
    },
    () => {
      t.fail('the stream should be successfully read to the end');
      t.end();
    }
  );

  setTimeout(() => {
    rs.cancel().then(() => {
      t.equal(cancelationFinished, true, 'it returns a promise that waits for the cancellation to finish');
      t.end();
    });
  }, 150);
});

test('ReadableStream is able to pull data repeatedly if it\'s available synchronously', t => {
  var i = 0;
  var rs = new ReadableStream({
    pull(enqueue, close) {
      if (++i <= 10) {
        enqueue(i);
      } else {
        close();
      }
    }
  });

  rs.wait().then(() => {
    var data = [];
    while (rs.state === 'readable') {
      data.push(rs.read());
    }

    t.deepEqual(data, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    t.end();
  });
});

test('ReadableStream wait() does not error when no more data is available', t => {
  // https://github.com/whatwg/streams/issues/80

  t.plan(1);

  var rs = sequentialReadableStream(5, { async: true });
  var result = [];

  pump();

  function pump() {
    while (rs.state === 'readable') {
      result.push(rs.read());
    }

    if (rs.state === 'closed') {
      t.deepEqual(result, [1, 2, 3, 4, 5], 'got the expected 5 chunks');
    } else {
      rs.wait().then(pump, r => t.ifError(r));
    }
  }
});

test('ReadableStream should be able to get data sequentially from an asynchronous stream', t => {
  // https://github.com/whatwg/streams/issues/80

  t.plan(4);

  var rs = sequentialReadableStream(3, { async: true });

  var result = [];
  var EOF = Object.create(null);

  getNext().then(v => {
    t.equal(v, 1, 'first chunk should be 1');
    return getNext().then(v => {
      t.equal(v, 2, 'second chunk should be 2');
      return getNext().then(v => {
        t.equal(v, 3, 'third chunk should be 3');
        return getNext().then(v => {
          t.equal(v, EOF, 'fourth result should be EOF');
        });
      });
    });
  })
  .catch(r => t.ifError(r));

  function getNext() {
    if (rs.state === 'closed') {
      return Promise.resolve(EOF);
    }

    return rs.wait().then(() => {
      if (rs.state === 'readable') {
        return rs.read();
      } else if (rs.state === 'closed') {
        return EOF;
      }
    });
  }
});

test('ReadableStream cancellation puts the stream in a closed state (no chunks pulled yet)', t => {
  var rs = sequentialReadableStream(5);

  t.plan(5);

  rs.closed.then(
    () => t.assert(true, 'closed promise vended before the cancellation should fulfill'),
    () => t.fail('closed promise vended before the cancellation should not be rejected')
  );

  rs.wait().then(
    () => t.assert(true, 'wait() promise vended before the cancellation should fulfill'),
    () => t.fail('wait() promise vended before the cancellation should not be rejected')
  );

  rs.cancel();

  t.equal(rs.state, 'closed', 'state should be closed');

  rs.closed.then(
    () => t.assert(true, 'closed promise vended after the cancellation should fulfill'),
    () => t.fail('closed promise vended after the cancellation should not be rejected')
  );
  rs.wait().then(
    () => t.assert(true, 'wait promise vended after the cancellation should fulfill'),
    () => t.fail('wait promise vended after the cancellation should not be rejected')
  );
});

test('ReadableStream cancellation puts the stream in a closed state (after waiting for chunks)', t => {
  var rs = sequentialReadableStream(5);

  t.plan(5);

  rs.wait().then(
    () => {
      rs.closed.then(
        () => t.assert(true, 'closed promise vended before the cancellation should fulfill'),
        () => t.fail('closed promise vended before the cancellation should not be rejected')
      );

      rs.wait().then(
        () => t.assert(true, 'wait() promise vended before the cancellation should fulfill'),
        () => t.fail('wait() promise vended before the cancellation should not be rejected')
      );

      rs.cancel();

      t.equal(rs.state, 'closed', 'state should be closed');

      rs.closed.then(
        () => t.assert(true, 'closed promise vended after the cancellation should fulfill'),
        () => t.fail('closed promise vended after the cancellation should not be rejected')
      );
      rs.wait().then(
        () => t.assert(true, 'wait promise vended after the cancellation should fulfill'),
        () => t.fail('wait promise vended after the cancellation should not be rejected')
      );
    },
    r => t.ifError(r)
  );
});

test('ReadableStream returns `true` for the first `enqueue` call; `false` thereafter, if nobody reads', t => {
  t.plan(5);

  new ReadableStream({
    start(enqueue) {
      t.equal(enqueue('hi'), true);
      t.equal(enqueue('hey'), false);
      t.equal(enqueue('whee'), false);
      t.equal(enqueue('yo'), false);
      t.equal(enqueue('sup'), false);
    }
  });
});

test('ReadableStream continues returning `true` from `enqueue` if the data is read out of it in time', t => {
  t.plan(12);

  var rs = new ReadableStream({
    start(enqueue) {
      // Delay a bit so that the stream is successfully constructed and thus the `rs` variable references something.
      setTimeout(() => {
        t.equal(enqueue('hi'), true);
        t.equal(rs.state, 'readable');
        t.equal(rs.read(), 'hi');
        t.equal(rs.state, 'waiting');

        t.equal(enqueue('hey'), true);
        t.equal(rs.state, 'readable');
        t.equal(rs.read(), 'hey');
        t.equal(rs.state, 'waiting');

        t.equal(enqueue('whee'), true);
        t.equal(rs.state, 'readable');
        t.equal(rs.read(), 'whee');
        t.equal(rs.state, 'waiting');
      }, 0);
    }
  });
});