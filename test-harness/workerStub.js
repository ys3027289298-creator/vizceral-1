function StubWorker () {
  if (!(this instanceof StubWorker)) return new StubWorker();
}
StubWorker.prototype.postMessage = function postMessage () {};
StubWorker.prototype.terminate = function terminate () {};
StubWorker.prototype.addEventListener = function addEventListener () {};
StubWorker.prototype.removeEventListener = function removeEventListener () {};

module.exports = StubWorker;
