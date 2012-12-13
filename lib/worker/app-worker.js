/**
 * An AppWorker is responsible for:
 *
 * - Launching a Shiny application with the proper user/group permissions
 * - Ensuring that stderr is written to the specified path
 * - Returning a promise that resolves when the worker process exits
 */

var child_process = require('child_process');
var fs = require('fs');
var path = require('path');
var util = require('util');
var bash = require('bash');
var Q = require('q');
var _ = require('underscore');

var rprog = process.env.R || 'R';
var scriptPath = path.normalize(__dirname + '/../../R/SockJSAdapter.R');

function exists_p(path) {
  var defer = Q.defer();
  fs.exists(path, function(exists) {
    defer.resolve(exists);
  });
  return defer.promise;
}

/**
 * Begins launching the worker; returns a promise that resolves when
 * the worker is constructed (doesn't necessarily mean the process has
 * actually begun running though).
 *
 * @param {AppSpec} appSpec - Contains the basic details about the app to
 *   launch
 * @param {Number} listenPort - The port number that the Shiny app should use.
 * @param {String} logFilePath - The file path to write stderr to.
 */
function launchWorker_p(appSpec, listenPort, logFilePath) {
  
  if (!appSpec.runAs)
    return Q.reject(new Error("No user specified"));

  if (!appSpec.appDir)
    return Q.reject(new Error("No app directory specified"));


  return exists_p(appSpec.appDir).then(function(exists) {
    if (!exists) {
      var err = new Error("App directory does not exist");
      err.code = 'ENOTFOUND';
      throw err;
    }
    
    // Open the log file asynchronously, then create the worker
    return Q.nfcall(fs.open, logFilePath, 'a', 0666).then(function(logStream) {

      // Create the worker; when it exits (or fails to start), close
      // the logStream.
      var worker = new AppWorker(appSpec, listenPort, logStream);
      worker.getExit_p().fin(function() {
        logStream.end();
      });

      return worker;
    });
  })
};
exports.launchWorker_p = launchWorker_p;

/**
 * Like launchWorker_p, but the promise it returns doesn't resolve until
 * the worker process exits.
 */
function runWorker_p(appSpec, listenPort, logFilePath) {
  return launchWorker_p(appSpec, listenPort, logFilePath).invoke('getExit_p');
};
exports.runWorker_p = runWorker_p;

/**
 * An AppWorker models a single R process that is running a Shiny app.
 *
 * @constructor
 * @param {AppSpec} appSpec - Contains the basic details about the app to
 *   launch
 * @param {Number} listenPort - The port number that the Shiny app should use.
 * @param {Stream} logStream - The stream to dump stderr to.
 */
var AppWorker = function(appSpec, listenPort, logStream) {
  this.$dfEnded = Q.defer();
  var self = this;

  // Spawn worker process via su, to ensure proper setgid, initgroups, setuid,
  // etc. are called correctly.
  //
  // We use stdin to tell SockJSAdapter what app dir, port, etc. to use, so
  // that non-root users on the system can't use ps to discover what apps are
  // available and on what ports.

  try {
    // Run R
    var args = [
      '--',
      appSpec.runAs,
      '-c',
      bash.escape(rprog) + " --no-save --slave -f " + bash.escape(scriptPath)
    ];

    this.$proc = child_process.spawn('su', args, {
      stdio: ['pipe', 'ignore', logStream]
    });
    this.$proc.on('exit', function(code, signal) {
      self.$dfEnded.resolve({code: code, signal: signal});
    });
    this.$proc.stdin.end(
      appSpec.appDir + '\n' +
      listenPort + '\n' +
      (appSpec.settings.gaTrackingId || '') + '\n'
    );
  }
  catch (e) {
    this.$dfEnded.reject(e);
  }
};

(function() {

  /**
   * Returns a promise that is resolved when the process exits.
   * If the process terminated normally, code is the final exit
   * code of the process, otherwise null. If the process
   * terminated due to receipt of a signal, signal is the string
   * name of the signal, otherwise null.
   */
  this.getExit_p = function() {
    return this.$dfEnded.promise;
  };

  this.kill = function(signal) {
    this.$proc.kill(signal);
  };

}).call(AppWorker.prototype);