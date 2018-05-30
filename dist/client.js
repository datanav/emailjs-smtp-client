'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }(); /* eslint-disable camelcase */

var _emailjsBase = require('emailjs-base64');

var _emailjsTcpSocket = require('emailjs-tcp-socket');

var _emailjsTcpSocket2 = _interopRequireDefault(_emailjsTcpSocket);

var _textEncoding = require('text-encoding');

var _parser = require('./parser');

var _parser2 = _interopRequireDefault(_parser);

var _logger = require('./logger');

var _logger2 = _interopRequireDefault(_logger);

var _common = require('./common');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var DEBUG_TAG = 'SMTP Client';

/**
 * Lower Bound for socket timeout to wait since the last data was written to a socket
 */
var TIMEOUT_SOCKET_LOWER_BOUND = 10000;

/**
 * Multiplier for socket timeout:
 *
 * We assume at least a GPRS connection with 115 kb/s = 14,375 kB/s tops, so 10 KB/s to be on
 * the safe side. We can timeout after a lower bound of 10s + (n KB / 10 KB/s). A 1 MB message
 * upload would be 110 seconds to wait for the timeout. 10 KB/s === 0.1 s/B
 */
var TIMEOUT_SOCKET_MULTIPLIER = 0.1;

var SmtpClient = function () {
  /**
   * Creates a connection object to a SMTP server and allows to send mail through it.
   * Call `connect` method to inititate the actual connection, the constructor only
   * defines the properties but does not actually connect.
   *
   * NB! The parameter order (host, port) differs from node.js "way" (port, host)
   *
   * @constructor
   *
   * @param {String} [host="localhost"] Hostname to conenct to
   * @param {Number} [port=25] Port number to connect to
   * @param {Object} [options] Optional options object
   * @param {Boolean} [options.useSecureTransport] Set to true, to use encrypted connection
   * @param {String} [options.name] Client hostname for introducing itself to the server
   * @param {Object} [options.auth] Authentication options. Depends on the preferred authentication method. Usually {user, pass}
   * @param {String} [options.authMethod] Force specific authentication method
   * @param {Boolean} [options.disableEscaping] If set to true, do not escape dots on the beginning of the lines
   */
  function SmtpClient(host, port) {
    var options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};

    _classCallCheck(this, SmtpClient);

    this.timeoutSocketLowerBound = TIMEOUT_SOCKET_LOWER_BOUND;
    this.timeoutSocketMultiplier = TIMEOUT_SOCKET_MULTIPLIER;

    this.port = port || (this.options.useSecureTransport ? 465 : 25);
    this.host = host || 'localhost';

    this.options = options;
    /**
     * If set to true, start an encrypted connection instead of the plaintext one
     * (recommended if applicable). If useSecureTransport is not set but the port used is 465,
     * then ecryption is used by default.
     */
    this.options.useSecureTransport = 'useSecureTransport' in this.options ? !!this.options.useSecureTransport : this.port === 465;

    this.options.auth = this.options.auth || false; // Authentication object. If not set, authentication step will be skipped.
    this.options.name = this.options.name || 'localhost'; // Hostname of the client, this will be used for introducing to the server
    this.socket = false; // Downstream TCP socket to the SMTP server, created with mozTCPSocket
    this.destroyed = false; // Indicates if the connection has been closed and can't be used anymore
    this.waitDrain = false; // Keeps track if the downstream socket is currently full and a drain event should be waited for or not

    // Private properties

    this._parser = new _parser2.default(); // SMTP response parser object. All data coming from the downstream server is feeded to this parser
    this._authenticatedAs = null; // If authenticated successfully, stores the username
    this._supportedAuth = []; // A list of authentication mechanisms detected from the EHLO response and which are compatible with this library
    this._dataMode = false; // If true, accepts data from the upstream to be passed directly to the downstream socket. Used after the DATA command
    this._lastDataBytes = ''; // Keep track of the last bytes to see how the terminating dot should be placed
    this._envelope = null; // Envelope object for tracking who is sending mail to whom
    this._currentAction = null; // Stores the function that should be run after a response has been received from the server
    this._secureMode = !!this.options.useSecureTransport; // Indicates if the connection is secured or plaintext
    this._socketTimeoutTimer = false; // Timer waiting to declare the socket dead starting from the last write
    this._socketTimeoutStart = false; // Start time of sending the first packet in data mode
    this._socketTimeoutPeriod = false; // Timeout for sending in data mode, gets extended with every send()

    // Activate logging
    this.createLogger();

    // Event placeholders
    this.onerror = function (e) {}; // Will be run when an error occurs. The `onclose` event will fire subsequently.
    this.ondrain = function () {}; // More data can be buffered in the socket.
    this.onclose = function () {}; // The connection to the server has been closed
    this.onidle = function () {}; // The connection is established and idle, you can send mail now
    this.onready = function (failedRecipients) {}; // Waiting for mail body, lists addresses that were not accepted as recipients
    this.ondone = function (success) {}; // The mail has been sent. Wait for `onidle` next. Indicates if the message was queued by the server.
  }

  /**
   * Initiate a connection to the server
   */


  _createClass(SmtpClient, [{
    key: 'connect',
    value: function connect() {
      var SocketContructor = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : _emailjsTcpSocket2.default;

      this.socket = SocketContructor.open(this.host, this.port, {
        binaryType: 'arraybuffer',
        useSecureTransport: this._secureMode,
        ca: this.options.ca,
        tlsWorkerPath: this.options.tlsWorkerPath,
        ws: this.options.ws
      });

      // allows certificate handling for platform w/o native tls support
      // oncert is non standard so setting it might throw if the socket object is immutable
      try {
        this.socket.oncert = this.oncert;
      } catch (E) {}
      this.socket.onerror = this._onError.bind(this);
      this.socket.onopen = this._onOpen.bind(this);
    }

    /**
     * Pauses `data` events from the downstream SMTP server
     */

  }, {
    key: 'suspend',
    value: function suspend() {
      if (this.socket && this.socket.readyState === 'open') {
        this.socket.suspend();
      }
    }

    /**
     * Resumes `data` events from the downstream SMTP server. Be careful of not
     * resuming something that is not suspended - an error is thrown in this case
     */

  }, {
    key: 'resume',
    value: function resume() {
      if (this.socket && this.socket.readyState === 'open') {
        this.socket.resume();
      }
    }

    /**
     * Sends QUIT
     */

  }, {
    key: 'quit',
    value: function quit() {
      this.logger.debug(DEBUG_TAG, 'Sending QUIT...');
      this._sendCommand('QUIT');
      this._currentAction = this.close;
    }

    /**
     * Reset authentication
     *
     * @param {Object} [auth] Use this if you want to authenticate as another user
     */

  }, {
    key: 'reset',
    value: function reset(auth) {
      this.options.auth = auth || this.options.auth;
      this.logger.debug(DEBUG_TAG, 'Sending RSET...');
      this._sendCommand('RSET');
      this._currentAction = this._actionRSET;
    }

    /**
     * Closes the connection to the server
     */

  }, {
    key: 'close',
    value: function close() {
      this.logger.debug(DEBUG_TAG, 'Closing connection...');
      if (this.socket && this.socket.readyState === 'open') {
        this.socket.close();
      } else {
        this._destroy();
      }
    }

    // Mail related methods

    /**
     * Initiates a new message by submitting envelope data, starting with
     * `MAIL FROM:` command. Use after `onidle` event
     *
     * @param {Object} envelope Envelope object in the form of {from:"...", to:["..."]}
     */

  }, {
    key: 'useEnvelope',
    value: function useEnvelope(envelope) {
      this._envelope = envelope || {};
      this._envelope.from = [].concat(this._envelope.from || 'anonymous@' + this.options.name)[0];
      this._envelope.to = [].concat(this._envelope.to || []);

      // clone the recipients array for latter manipulation
      this._envelope.rcptQueue = [].concat(this._envelope.to);
      this._envelope.rcptFailed = [];
      this._envelope.responseQueue = [];

      this._currentAction = this._actionMAIL;
      this.logger.debug(DEBUG_TAG, 'Sending MAIL FROM...');
      this._sendCommand('MAIL FROM:<' + this._envelope.from + '>');
    }

    /**
     * Send ASCII data to the server. Works only in data mode (after `onready` event), ignored
     * otherwise
     *
     * @param {String} chunk ASCII string (quoted-printable, base64 etc.) to be sent to the server
     * @return {Boolean} If true, it is safe to send more data, if false, you *should* wait for the ondrain event before sending more
     */

  }, {
    key: 'send',
    value: function send(chunk) {
      // works only in data mode
      if (!this._dataMode) {
        // this line should never be reached but if it does,
        // act like everything's normal.
        return true;
      }

      // TODO: if the chunk is an arraybuffer, use a separate function to send the data
      return this._sendString(chunk);
    }

    /**
     * Indicates that a data stream for the socket is ended. Works only in data
     * mode (after `onready` event), ignored otherwise. Use it when you are done
     * with sending the mail. This method does not close the socket. Once the mail
     * has been queued by the server, `ondone` and `onidle` are emitted.
     *
     * @param {Buffer} [chunk] Chunk of data to be sent to the server
     */

  }, {
    key: 'end',
    value: function end(chunk) {
      // works only in data mode
      if (!this._dataMode) {
        // this line should never be reached but if it does,
        // act like everything's normal.
        return true;
      }

      if (chunk && chunk.length) {
        this.send(chunk);
      }

      // redirect output from the server to _actionStream
      this._currentAction = this._actionStream;

      // indicate that the stream has ended by sending a single dot on its own line
      // if the client already closed the data with \r\n no need to do it again
      if (this._lastDataBytes === '\r\n') {
        this.waitDrain = this._send(new Uint8Array([0x2E, 0x0D, 0x0A]).buffer); // .\r\n
      } else if (this._lastDataBytes.substr(-1) === '\r') {
        this.waitDrain = this._send(new Uint8Array([0x0A, 0x2E, 0x0D, 0x0A]).buffer); // \n.\r\n
      } else {
        this.waitDrain = this._send(new Uint8Array([0x0D, 0x0A, 0x2E, 0x0D, 0x0A]).buffer); // \r\n.\r\n
      }

      // end data mode, reset the variables for extending the timeout in data mode
      this._dataMode = false;
      this._socketTimeoutStart = false;
      this._socketTimeoutPeriod = false;

      return this.waitDrain;
    }

    // PRIVATE METHODS

    // EVENT HANDLERS FOR THE SOCKET

    /**
     * Connection listener that is run when the connection to the server is opened.
     * Sets up different event handlers for the opened socket
     *
     * @event
     * @param {Event} evt Event object. Not used
     */

  }, {
    key: '_onOpen',
    value: function _onOpen(event) {
      if (event && event.data && event.data.proxyHostname) {
        this.options.name = event.data.proxyHostname;
      }

      this.socket.ondata = this._onData.bind(this);

      this.socket.onclose = this._onClose.bind(this);
      this.socket.ondrain = this._onDrain.bind(this);

      this._parser.ondata = this._onCommand.bind(this);

      this._currentAction = this._actionGreeting;
    }

    /**
     * Data listener for chunks of data emitted by the server
     *
     * @event
     * @param {Event} evt Event object. See `evt.data` for the chunk received
     */

  }, {
    key: '_onData',
    value: function _onData(evt) {
      clearTimeout(this._socketTimeoutTimer);
      var stringPayload = new _textEncoding.TextDecoder('UTF-8').decode(new Uint8Array(evt.data));
      this.logger.debug(DEBUG_TAG, 'SERVER: ' + stringPayload);
      this._parser.send(stringPayload);
    }

    /**
     * More data can be buffered in the socket, `waitDrain` is reset to false
     *
     * @event
     * @param {Event} evt Event object. Not used
     */

  }, {
    key: '_onDrain',
    value: function _onDrain() {
      this.waitDrain = false;
      this.ondrain();
    }

    /**
     * Error handler for the socket
     *
     * @event
     * @param {Event} evt Event object. See evt.data for the error
     */

  }, {
    key: '_onError',
    value: function _onError(evt) {
      if (evt instanceof Error && evt.message) {
        this.logger.error(DEBUG_TAG, evt);
        this.onerror(evt);
      } else if (evt && evt.data instanceof Error) {
        this.logger.error(DEBUG_TAG, evt.data);
        this.onerror(evt.data);
      } else {
        this.logger.error(DEBUG_TAG, new Error(evt && evt.data && evt.data.message || evt.data || evt || 'Error'));
        this.onerror(new Error(evt && evt.data && evt.data.message || evt.data || evt || 'Error'));
      }

      this.close();
    }

    /**
     * Indicates that the socket has been closed
     *
     * @event
     * @param {Event} evt Event object. Not used
     */

  }, {
    key: '_onClose',
    value: function _onClose() {
      this.logger.debug(DEBUG_TAG, 'Socket closed.');
      this._destroy();
    }

    /**
     * This is not a socket data handler but the handler for data emitted by the parser,
     * so this data is safe to use as it is always complete (server might send partial chunks)
     *
     * @event
     * @param {Object} command Parsed data
     */

  }, {
    key: '_onCommand',
    value: function _onCommand(command) {
      if (typeof this._currentAction === 'function') {
        this._currentAction(command);
      }
    }
  }, {
    key: '_onTimeout',
    value: function _onTimeout() {
      // inform about the timeout and shut down
      var error = new Error('Socket timed out!');
      this._onError(error);
    }

    /**
     * Ensures that the connection is closed and such
     */

  }, {
    key: '_destroy',
    value: function _destroy() {
      clearTimeout(this._socketTimeoutTimer);

      if (!this.destroyed) {
        this.destroyed = true;
        this.onclose();
      }
    }

    /**
     * Sends a string to the socket.
     *
     * @param {String} chunk ASCII string (quoted-printable, base64 etc.) to be sent to the server
     * @return {Boolean} If true, it is safe to send more data, if false, you *should* wait for the ondrain event before sending more
     */

  }, {
    key: '_sendString',
    value: function _sendString(chunk) {
      // escape dots
      if (!this.options.disableEscaping) {
        chunk = chunk.replace(/\n\./g, '\n..');
        if ((this._lastDataBytes.substr(-1) === '\n' || !this._lastDataBytes) && chunk.charAt(0) === '.') {
          chunk = '.' + chunk;
        }
      }

      // Keeping eye on the last bytes sent, to see if there is a <CR><LF> sequence
      // at the end which is needed to end the data stream
      if (chunk.length > 2) {
        this._lastDataBytes = chunk.substr(-2);
      } else if (chunk.length === 1) {
        this._lastDataBytes = this._lastDataBytes.substr(-1) + chunk;
      }

      this.logger.debug(DEBUG_TAG, 'Sending ' + chunk.length + ' bytes of payload');

      // pass the chunk to the socket
      this.waitDrain = this._send(new _textEncoding.TextEncoder('UTF-8').encode(chunk).buffer);
      return this.waitDrain;
    }

    /**
     * Send a string command to the server, also append \r\n if needed
     *
     * @param {String} str String to be sent to the server
     */

  }, {
    key: '_sendCommand',
    value: function _sendCommand(str) {
      this.waitDrain = this._send(new _textEncoding.TextEncoder('UTF-8').encode(str + (str.substr(-2) !== '\r\n' ? '\r\n' : '')).buffer);
    }
  }, {
    key: '_send',
    value: function _send(buffer) {
      this._setTimeout(buffer.byteLength);
      return this.socket.send(buffer);
    }
  }, {
    key: '_setTimeout',
    value: function _setTimeout(byteLength) {
      var prolongPeriod = Math.floor(byteLength * this.timeoutSocketMultiplier);
      var timeout;

      if (this._dataMode) {
        // we're in data mode, so we count only one timeout that get extended for every send().
        var now = Date.now();

        // the old timeout start time
        this._socketTimeoutStart = this._socketTimeoutStart || now;

        // the old timeout period, normalized to a minimum of TIMEOUT_SOCKET_LOWER_BOUND
        this._socketTimeoutPeriod = (this._socketTimeoutPeriod || this.timeoutSocketLowerBound) + prolongPeriod;

        // the new timeout is the delta between the new firing time (= timeout period + timeout start time) and now
        timeout = this._socketTimeoutStart + this._socketTimeoutPeriod - now;
      } else {
        // set new timout
        timeout = this.timeoutSocketLowerBound + prolongPeriod;
      }

      clearTimeout(this._socketTimeoutTimer); // clear pending timeouts
      this._socketTimeoutTimer = setTimeout(this._onTimeout.bind(this), timeout); // arm the next timeout
    }

    /**
     * Intitiate authentication sequence if needed
     */

  }, {
    key: '_authenticateUser',
    value: function _authenticateUser() {
      if (!this.options.auth) {
        // no need to authenticate, at least no data given
        this._currentAction = this._actionIdle;
        this.onidle(); // ready to take orders
        return;
      }

      var auth;

      if (!this.options.authMethod && this.options.auth.xoauth2) {
        this.options.authMethod = 'XOAUTH2';
      }

      if (this.options.authMethod) {
        auth = this.options.authMethod.toUpperCase().trim();
      } else {
        // use first supported
        auth = (this._supportedAuth[0] || 'PLAIN').toUpperCase().trim();
      }

      switch (auth) {
        case 'LOGIN':
          // LOGIN is a 3 step authentication process
          // C: AUTH LOGIN
          // C: BASE64(USER)
          // C: BASE64(PASS)
          this.logger.debug(DEBUG_TAG, 'Authentication via AUTH LOGIN');
          this._currentAction = this._actionAUTH_LOGIN_USER;
          this._sendCommand('AUTH LOGIN');
          return;
        case 'PLAIN':
          // AUTH PLAIN is a 1 step authentication process
          // C: AUTH PLAIN BASE64(\0 USER \0 PASS)
          this.logger.debug(DEBUG_TAG, 'Authentication via AUTH PLAIN');
          this._currentAction = this._actionAUTHComplete;
          this._sendCommand(
          // convert to BASE64
          'AUTH PLAIN ' + (0, _emailjsBase.encode)(
          // this.options.auth.user+'\u0000'+
          '\0' + // skip authorization identity as it causes problems with some servers
          this.options.auth.user + '\0' + this.options.auth.pass));
          return;
        case 'XOAUTH2':
          // See https://developers.google.com/gmail/xoauth2_protocol#smtp_protocol_exchange
          this.logger.debug(DEBUG_TAG, 'Authentication via AUTH XOAUTH2');
          this._currentAction = this._actionAUTH_XOAUTH2;
          this._sendCommand('AUTH XOAUTH2 ' + this._buildXOAuth2Token(this.options.auth.user, this.options.auth.xoauth2));
          return;
      }

      this._onError(new Error('Unknown authentication method ' + auth));
    }

    // ACTIONS FOR RESPONSES FROM THE SMTP SERVER

    /**
     * Initial response from the server, must have a status 220
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionGreeting',
    value: function _actionGreeting(command) {
      if (command.statusCode !== 220) {
        this._onError(new Error('Invalid greeting: ' + command.data));
        return;
      }

      if (this.options.lmtp) {
        this.logger.debug(DEBUG_TAG, 'Sending LHLO ' + this.options.name);

        this._currentAction = this._actionLHLO;
        this._sendCommand('LHLO ' + this.options.name);
      } else {
        this.logger.debug(DEBUG_TAG, 'Sending EHLO ' + this.options.name);

        this._currentAction = this._actionEHLO;
        this._sendCommand('EHLO ' + this.options.name);
      }
    }

    /**
     * Response to LHLO
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionLHLO',
    value: function _actionLHLO(command) {
      if (!command.success) {
        this.logger.error(DEBUG_TAG, 'LHLO not successful');
        this._onError(new Error(command.data));
        return;
      }

      // Process as EHLO response
      this._actionEHLO(command);
    }

    /**
     * Response to EHLO. If the response is an error, try HELO instead
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionEHLO',
    value: function _actionEHLO(command) {
      var match;

      if (!command.success) {
        if (!this._secureMode && this.options.requireTLS) {
          var errMsg = 'STARTTLS not supported without EHLO';
          this.logger.error(DEBUG_TAG, errMsg);
          this._onError(new Error(errMsg));
          return;
        }

        // Try HELO instead
        this.logger.warn(DEBUG_TAG, 'EHLO not successful, trying HELO ' + this.options.name);
        this._currentAction = this._actionHELO;
        this._sendCommand('HELO ' + this.options.name);
        return;
      }

      // Detect if the server supports PLAIN auth
      if (command.line.match(/AUTH(?:\s+[^\n]*\s+|\s+)PLAIN/i)) {
        this.logger.debug(DEBUG_TAG, 'Server supports AUTH PLAIN');
        this._supportedAuth.push('PLAIN');
      }

      // Detect if the server supports LOGIN auth
      if (command.line.match(/AUTH(?:\s+[^\n]*\s+|\s+)LOGIN/i)) {
        this.logger.debug(DEBUG_TAG, 'Server supports AUTH LOGIN');
        this._supportedAuth.push('LOGIN');
      }

      // Detect if the server supports XOAUTH2 auth
      if (command.line.match(/AUTH(?:\s+[^\n]*\s+|\s+)XOAUTH2/i)) {
        this.logger.debug(DEBUG_TAG, 'Server supports AUTH XOAUTH2');
        this._supportedAuth.push('XOAUTH2');
      }

      // Detect maximum allowed message size
      if ((match = command.line.match(/SIZE (\d+)/i)) && Number(match[1])) {
        var maxAllowedSize = Number(match[1]);
        this.logger.debug(DEBUG_TAG, 'Maximum allowd message size: ' + maxAllowedSize);
      }

      // Detect if the server supports STARTTLS
      if (!this._secureMode) {
        if (command.line.match(/[ -]STARTTLS\s?$/mi) && !this.options.ignoreTLS || !!this.options.requireTLS) {
          this._currentAction = this._actionSTARTTLS;
          this.logger.debug(DEBUG_TAG, 'Sending STARTTLS');
          this._sendCommand('STARTTLS');
          return;
        }
      }

      this._authenticateUser();
    }

    /**
     * Handles server response for STARTTLS command. If there's an error
     * try HELO instead, otherwise initiate TLS upgrade. If the upgrade
     * succeedes restart the EHLO
     *
     * @param {String} str Message from the server
     */

  }, {
    key: '_actionSTARTTLS',
    value: function _actionSTARTTLS(command) {
      if (!command.success) {
        this.logger.error(DEBUG_TAG, 'STARTTLS not successful');
        this._onError(new Error(command.data));
        return;
      }

      this._secureMode = true;
      this.socket.upgradeToSecure();

      // restart protocol flow
      this._currentAction = this._actionEHLO;
      this._sendCommand('EHLO ' + this.options.name);
    }

    /**
     * Response to HELO
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionHELO',
    value: function _actionHELO(command) {
      if (!command.success) {
        this.logger.error(DEBUG_TAG, 'HELO not successful');
        this._onError(new Error(command.data));
        return;
      }
      this._authenticateUser();
    }

    /**
     * Response to AUTH LOGIN, if successful expects base64 encoded username
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionAUTH_LOGIN_USER',
    value: function _actionAUTH_LOGIN_USER(command) {
      if (command.statusCode !== 334 || command.data !== 'VXNlcm5hbWU6') {
        this.logger.error(DEBUG_TAG, 'AUTH LOGIN USER not successful: ' + command.data);
        this._onError(new Error('Invalid login sequence while waiting for "334 VXNlcm5hbWU6 ": ' + command.data));
        return;
      }
      this.logger.debug(DEBUG_TAG, 'AUTH LOGIN USER successful');
      this._currentAction = this._actionAUTH_LOGIN_PASS;
      this._sendCommand((0, _emailjsBase.encode)(this.options.auth.user));
    }

    /**
     * Response to AUTH LOGIN username, if successful expects base64 encoded password
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionAUTH_LOGIN_PASS',
    value: function _actionAUTH_LOGIN_PASS(command) {
      if (command.statusCode !== 334 || command.data !== 'UGFzc3dvcmQ6') {
        this.logger.error(DEBUG_TAG, 'AUTH LOGIN PASS not successful: ' + command.data);
        this._onError(new Error('Invalid login sequence while waiting for "334 UGFzc3dvcmQ6 ": ' + command.data));
        return;
      }
      this.logger.debug(DEBUG_TAG, 'AUTH LOGIN PASS successful');
      this._currentAction = this._actionAUTHComplete;
      this._sendCommand((0, _emailjsBase.encode)(this.options.auth.pass));
    }

    /**
     * Response to AUTH XOAUTH2 token, if error occurs send empty response
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionAUTH_XOAUTH2',
    value: function _actionAUTH_XOAUTH2(command) {
      if (!command.success) {
        this.logger.warn(DEBUG_TAG, 'Error during AUTH XOAUTH2, sending empty response');
        this._sendCommand('');
        this._currentAction = this._actionAUTHComplete;
      } else {
        this._actionAUTHComplete(command);
      }
    }

    /**
     * Checks if authentication succeeded or not. If successfully authenticated
     * emit `idle` to indicate that an e-mail can be sent using this connection
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionAUTHComplete',
    value: function _actionAUTHComplete(command) {
      if (!command.success) {
        this.logger.debug(DEBUG_TAG, 'Authentication failed: ' + command.data);
        this._onError(new Error(command.data));
        return;
      }

      this.logger.debug(DEBUG_TAG, 'Authentication successful.');

      this._authenticatedAs = this.options.auth.user;

      this._currentAction = this._actionIdle;
      this.onidle(); // ready to take orders
    }

    /**
     * Used when the connection is idle and the server emits timeout
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionIdle',
    value: function _actionIdle(command) {
      if (command.statusCode > 300) {
        this._onError(new Error(command.line));
        return;
      }

      this._onError(new Error(command.data));
    }

    /**
     * Response to MAIL FROM command. Proceed to defining RCPT TO list if successful
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionMAIL',
    value: function _actionMAIL(command) {
      if (!command.success) {
        this.logger.debug(DEBUG_TAG, 'MAIL FROM unsuccessful: ' + command.data);
        this._onError(new Error(command.data));
        return;
      }

      if (!this._envelope.rcptQueue.length) {
        this._onError(new Error('Can\'t send mail - no recipients defined'));
      } else {
        this.logger.debug(DEBUG_TAG, 'MAIL FROM successful, proceeding with ' + this._envelope.rcptQueue.length + ' recipients');
        this.logger.debug(DEBUG_TAG, 'Adding recipient...');
        this._envelope.curRecipient = this._envelope.rcptQueue.shift();
        this._currentAction = this._actionRCPT;
        this._sendCommand('RCPT TO:<' + this._envelope.curRecipient + '>');
      }
    }

    /**
     * Response to a RCPT TO command. If the command is unsuccessful, try the next one,
     * as this might be related only to the current recipient, not a global error, so
     * the following recipients might still be valid
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionRCPT',
    value: function _actionRCPT(command) {
      if (!command.success) {
        this.logger.warn(DEBUG_TAG, 'RCPT TO failed for: ' + this._envelope.curRecipient);
        // this is a soft error
        this._envelope.rcptFailed.push(this._envelope.curRecipient);
      } else {
        this._envelope.responseQueue.push(this._envelope.curRecipient);
      }

      if (!this._envelope.rcptQueue.length) {
        if (this._envelope.rcptFailed.length < this._envelope.to.length) {
          this._currentAction = this._actionDATA;
          this.logger.debug(DEBUG_TAG, 'RCPT TO done, proceeding with payload');
          this._sendCommand('DATA');
        } else {
          this._onError(new Error('Can\'t send mail - all recipients were rejected'));
          this._currentAction = this._actionIdle;
        }
      } else {
        this.logger.debug(DEBUG_TAG, 'Adding recipient...');
        this._envelope.curRecipient = this._envelope.rcptQueue.shift();
        this._currentAction = this._actionRCPT;
        this._sendCommand('RCPT TO:<' + this._envelope.curRecipient + '>');
      }
    }

    /**
     * Response to the RSET command. If successful, clear the current authentication
     * information and reauthenticate.
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionRSET',
    value: function _actionRSET(command) {
      if (!command.success) {
        this.logger.error(DEBUG_TAG, 'RSET unsuccessful ' + command.data);
        this._onError(new Error(command.data));
        return;
      }

      this._authenticatedAs = null;
      this._authenticateUser();
    }

    /**
     * Response to the DATA command. Server is now waiting for a message, so emit `onready`
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionDATA',
    value: function _actionDATA(command) {
      // response should be 354 but according to this issue https://github.com/eleith/emailjs/issues/24
      // some servers might use 250 instead
      if ([250, 354].indexOf(command.statusCode) < 0) {
        this.logger.error(DEBUG_TAG, 'DATA unsuccessful ' + command.data);
        this._onError(new Error(command.data));
        return;
      }

      this._dataMode = true;
      this._currentAction = this._actionIdle;
      this.onready(this._envelope.rcptFailed);
    }

    /**
     * Response from the server, once the message stream has ended with <CR><LF>.<CR><LF>
     * Emits `ondone`.
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionStream',
    value: function _actionStream(command) {
      var rcpt;

      if (this.options.lmtp) {
        // LMTP returns a response code for *every* successfully set recipient
        // For every recipient the message might succeed or fail individually

        rcpt = this._envelope.responseQueue.shift();
        if (!command.success) {
          this.logger.error(DEBUG_TAG, 'Local delivery to ' + rcpt + ' failed.');
          this._envelope.rcptFailed.push(rcpt);
        } else {
          this.logger.error(DEBUG_TAG, 'Local delivery to ' + rcpt + ' succeeded.');
        }

        if (this._envelope.responseQueue.length) {
          this._currentAction = this._actionStream;
          return;
        }

        this._currentAction = this._actionIdle;
        this.ondone(true);
      } else {
        // For SMTP the message either fails or succeeds, there is no information
        // about individual recipients

        if (!command.success) {
          this.logger.error(DEBUG_TAG, 'Message sending failed.');
        } else {
          this.logger.debug(DEBUG_TAG, 'Message sent successfully.');
        }

        this._currentAction = this._actionIdle;
        this.ondone(!!command.success, command);
      }

      // If the client wanted to do something else (eg. to quit), do not force idle
      if (this._currentAction === this._actionIdle) {
        // Waiting for new connections
        this.logger.debug(DEBUG_TAG, 'Idling while waiting for new connections...');
        this.onidle();
      }
    }

    /**
     * Builds a login token for XOAUTH2 authentication command
     *
     * @param {String} user E-mail address of the user
     * @param {String} token Valid access token for the user
     * @return {String} Base64 formatted login token
     */

  }, {
    key: '_buildXOAuth2Token',
    value: function _buildXOAuth2Token(user, token) {
      var authData = ['user=' + (user || ''), 'auth=Bearer ' + token, '', ''];
      // base64("user={User}\x00auth=Bearer {Token}\x00\x00")
      return (0, _emailjsBase.encode)(authData.join('\x01'));
    }
  }, {
    key: 'createLogger',
    value: function createLogger() {
      var _this = this;

      var creator = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : _logger2.default;

      var logger = creator((this.options.auth || {}).user || '', this.host);
      this.logLevel = this.LOG_LEVEL_ALL;
      this.logger = {
        debug: function debug() {
          for (var _len = arguments.length, msgs = Array(_len), _key = 0; _key < _len; _key++) {
            msgs[_key] = arguments[_key];
          }

          if (_common.LOG_LEVEL_DEBUG >= _this.logLevel) {
            logger.debug(msgs);
          }
        },
        info: function info() {
          for (var _len2 = arguments.length, msgs = Array(_len2), _key2 = 0; _key2 < _len2; _key2++) {
            msgs[_key2] = arguments[_key2];
          }

          if (_common.LOG_LEVEL_INFO >= _this.logLevel) {
            logger.info(msgs);
          }
        },
        warn: function warn() {
          for (var _len3 = arguments.length, msgs = Array(_len3), _key3 = 0; _key3 < _len3; _key3++) {
            msgs[_key3] = arguments[_key3];
          }

          if (_common.LOG_LEVEL_WARN >= _this.logLevel) {
            logger.warn(msgs);
          }
        },
        error: function error() {
          for (var _len4 = arguments.length, msgs = Array(_len4), _key4 = 0; _key4 < _len4; _key4++) {
            msgs[_key4] = arguments[_key4];
          }

          if (_common.LOG_LEVEL_ERROR >= _this.logLevel) {
            logger.error(msgs);
          }
        }
      };
    }
  }]);

  return SmtpClient;
}();

exports.default = SmtpClient;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9jbGllbnQuanMiXSwibmFtZXMiOlsiREVCVUdfVEFHIiwiVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkQiLCJUSU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSIiwiU210cENsaWVudCIsImhvc3QiLCJwb3J0Iiwib3B0aW9ucyIsInRpbWVvdXRTb2NrZXRMb3dlckJvdW5kIiwidGltZW91dFNvY2tldE11bHRpcGxpZXIiLCJ1c2VTZWN1cmVUcmFuc3BvcnQiLCJhdXRoIiwibmFtZSIsInNvY2tldCIsImRlc3Ryb3llZCIsIndhaXREcmFpbiIsIl9wYXJzZXIiLCJTbXRwQ2xpZW50UmVzcG9uc2VQYXJzZXIiLCJfYXV0aGVudGljYXRlZEFzIiwiX3N1cHBvcnRlZEF1dGgiLCJfZGF0YU1vZGUiLCJfbGFzdERhdGFCeXRlcyIsIl9lbnZlbG9wZSIsIl9jdXJyZW50QWN0aW9uIiwiX3NlY3VyZU1vZGUiLCJfc29ja2V0VGltZW91dFRpbWVyIiwiX3NvY2tldFRpbWVvdXRTdGFydCIsIl9zb2NrZXRUaW1lb3V0UGVyaW9kIiwiY3JlYXRlTG9nZ2VyIiwib25lcnJvciIsImUiLCJvbmRyYWluIiwib25jbG9zZSIsIm9uaWRsZSIsIm9ucmVhZHkiLCJmYWlsZWRSZWNpcGllbnRzIiwib25kb25lIiwic3VjY2VzcyIsIlNvY2tldENvbnRydWN0b3IiLCJUQ1BTb2NrZXQiLCJvcGVuIiwiYmluYXJ5VHlwZSIsImNhIiwidGxzV29ya2VyUGF0aCIsIndzIiwib25jZXJ0IiwiRSIsIl9vbkVycm9yIiwiYmluZCIsIm9ub3BlbiIsIl9vbk9wZW4iLCJyZWFkeVN0YXRlIiwic3VzcGVuZCIsInJlc3VtZSIsImxvZ2dlciIsImRlYnVnIiwiX3NlbmRDb21tYW5kIiwiY2xvc2UiLCJfYWN0aW9uUlNFVCIsIl9kZXN0cm95IiwiZW52ZWxvcGUiLCJmcm9tIiwiY29uY2F0IiwidG8iLCJyY3B0UXVldWUiLCJyY3B0RmFpbGVkIiwicmVzcG9uc2VRdWV1ZSIsIl9hY3Rpb25NQUlMIiwiY2h1bmsiLCJfc2VuZFN0cmluZyIsImxlbmd0aCIsInNlbmQiLCJfYWN0aW9uU3RyZWFtIiwiX3NlbmQiLCJVaW50OEFycmF5IiwiYnVmZmVyIiwic3Vic3RyIiwiZXZlbnQiLCJkYXRhIiwicHJveHlIb3N0bmFtZSIsIm9uZGF0YSIsIl9vbkRhdGEiLCJfb25DbG9zZSIsIl9vbkRyYWluIiwiX29uQ29tbWFuZCIsIl9hY3Rpb25HcmVldGluZyIsImV2dCIsImNsZWFyVGltZW91dCIsInN0cmluZ1BheWxvYWQiLCJUZXh0RGVjb2RlciIsImRlY29kZSIsIkVycm9yIiwibWVzc2FnZSIsImVycm9yIiwiY29tbWFuZCIsImRpc2FibGVFc2NhcGluZyIsInJlcGxhY2UiLCJjaGFyQXQiLCJUZXh0RW5jb2RlciIsImVuY29kZSIsInN0ciIsIl9zZXRUaW1lb3V0IiwiYnl0ZUxlbmd0aCIsInByb2xvbmdQZXJpb2QiLCJNYXRoIiwiZmxvb3IiLCJ0aW1lb3V0Iiwibm93IiwiRGF0ZSIsInNldFRpbWVvdXQiLCJfb25UaW1lb3V0IiwiX2FjdGlvbklkbGUiLCJhdXRoTWV0aG9kIiwieG9hdXRoMiIsInRvVXBwZXJDYXNlIiwidHJpbSIsIl9hY3Rpb25BVVRIX0xPR0lOX1VTRVIiLCJfYWN0aW9uQVVUSENvbXBsZXRlIiwidXNlciIsInBhc3MiLCJfYWN0aW9uQVVUSF9YT0FVVEgyIiwiX2J1aWxkWE9BdXRoMlRva2VuIiwic3RhdHVzQ29kZSIsImxtdHAiLCJfYWN0aW9uTEhMTyIsIl9hY3Rpb25FSExPIiwibWF0Y2giLCJyZXF1aXJlVExTIiwiZXJyTXNnIiwid2FybiIsIl9hY3Rpb25IRUxPIiwibGluZSIsInB1c2giLCJOdW1iZXIiLCJtYXhBbGxvd2VkU2l6ZSIsImlnbm9yZVRMUyIsIl9hY3Rpb25TVEFSVFRMUyIsIl9hdXRoZW50aWNhdGVVc2VyIiwidXBncmFkZVRvU2VjdXJlIiwiX2FjdGlvbkFVVEhfTE9HSU5fUEFTUyIsImN1clJlY2lwaWVudCIsInNoaWZ0IiwiX2FjdGlvblJDUFQiLCJfYWN0aW9uREFUQSIsImluZGV4T2YiLCJyY3B0IiwidG9rZW4iLCJhdXRoRGF0YSIsImpvaW4iLCJjcmVhdG9yIiwiY3JlYXRlRGVmYXVsdExvZ2dlciIsImxvZ0xldmVsIiwiTE9HX0xFVkVMX0FMTCIsIm1zZ3MiLCJMT0dfTEVWRUxfREVCVUciLCJpbmZvIiwiTE9HX0xFVkVMX0lORk8iLCJMT0dfTEVWRUxfV0FSTiIsIkxPR19MRVZFTF9FUlJPUiJdLCJtYXBwaW5ncyI6Ijs7Ozs7O3FqQkFBQTs7QUFFQTs7QUFDQTs7OztBQUNBOztBQUNBOzs7O0FBQ0E7Ozs7QUFDQTs7Ozs7O0FBT0EsSUFBSUEsWUFBWSxhQUFoQjs7QUFFQTs7O0FBR0EsSUFBTUMsNkJBQTZCLEtBQW5DOztBQUVBOzs7Ozs7O0FBT0EsSUFBTUMsNEJBQTRCLEdBQWxDOztJQUVNQyxVO0FBQ0o7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQWtCQSxzQkFBYUMsSUFBYixFQUFtQkMsSUFBbkIsRUFBdUM7QUFBQSxRQUFkQyxPQUFjLHVFQUFKLEVBQUk7O0FBQUE7O0FBQ3JDLFNBQUtDLHVCQUFMLEdBQStCTiwwQkFBL0I7QUFDQSxTQUFLTyx1QkFBTCxHQUErQk4seUJBQS9COztBQUVBLFNBQUtHLElBQUwsR0FBWUEsU0FBUyxLQUFLQyxPQUFMLENBQWFHLGtCQUFiLEdBQWtDLEdBQWxDLEdBQXdDLEVBQWpELENBQVo7QUFDQSxTQUFLTCxJQUFMLEdBQVlBLFFBQVEsV0FBcEI7O0FBRUEsU0FBS0UsT0FBTCxHQUFlQSxPQUFmO0FBQ0E7Ozs7O0FBS0EsU0FBS0EsT0FBTCxDQUFhRyxrQkFBYixHQUFrQyx3QkFBd0IsS0FBS0gsT0FBN0IsR0FBdUMsQ0FBQyxDQUFDLEtBQUtBLE9BQUwsQ0FBYUcsa0JBQXRELEdBQTJFLEtBQUtKLElBQUwsS0FBYyxHQUEzSDs7QUFFQSxTQUFLQyxPQUFMLENBQWFJLElBQWIsR0FBb0IsS0FBS0osT0FBTCxDQUFhSSxJQUFiLElBQXFCLEtBQXpDLENBZnFDLENBZVU7QUFDL0MsU0FBS0osT0FBTCxD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QUEsVUFBL0JDLE9BQStCLHVFQUFyQkMsZ0JBQXFCOztBQUMzQyxVQUFNaEcsU0FBUytGLFFBQVEsQ0FBQyxLQUFLOUksT0FBTCxDQUFhSSxJQUFiLElBQXFCLEVBQXRCLEVBQTBCMkcsSUFBMUIsSUFBa0MsRUFBMUMsRUFBOEMsS0FBS2pILElBQW5ELENBQWY7QUFDQSxXQUFLa0osUUFBTCxHQUFnQixLQUFLQyxhQUFyQjtBQUNBLFdBQUtsRyxNQUFMLEdBQWM7QUFDWkMsZUFBTyxpQkFBYTtBQUFBLDRDQUFUa0csSUFBUztBQUFUQSxnQkFBUztBQUFBOztBQUFFLGNBQUlDLDJCQUFtQixNQUFLSCxRQUE1QixFQUFzQztBQUFFakcsbUJBQU9DLEtBQVAsQ0FBYWtHLElBQWI7QUFBb0I7QUFBRSxTQUR4RTtBQUVaRSxjQUFNLGdCQUFhO0FBQUEsNkNBQVRGLElBQVM7QUFBVEEsZ0JBQVM7QUFBQTs7QUFBRSxjQUFJRywwQkFBa0IsTUFBS0wsUUFBM0IsRUFBcUM7QUFBRWpHLG1CQUFPcUcsSUFBUCxDQUFZRixJQUFaO0FBQW1CO0FBQUUsU0FGckU7QUFHWnhCLGNBQU0sZ0JBQWE7QUFBQSw2Q0FBVHdCLElBQVM7QUFBVEEsZ0JBQVM7QUFBQTs7QUFBRSxjQUFJSSwwQkFBa0IsTUFBS04sUUFBM0IsRUFBcUM7QUFBRWpHLG1CQUFPMkUsSUFBUCxDQUFZd0IsSUFBWjtBQUFtQjtBQUFFLFNBSHJFO0FBSVo1RCxlQUFPLGlCQUFhO0FBQUEsNkNBQVQ0RCxJQUFTO0FBQVRBLGdCQUFTO0FBQUE7O0FBQUUsY0FBSUssMkJBQW1CLE1BQUtQLFFBQTVCLEVBQXNDO0FBQUVqRyxtQkFBT3VDLEtBQVAsQ0FBYTRELElBQWI7QUFBb0I7QUFBRTtBQUp4RSxPQUFkO0FBTUQ7Ozs7OztrQkFHWXJKLFUiLCJmaWxlIjoiY2xpZW50LmpzIiwic291cmNlc0NvbnRlbnQiOlsiLyogZXNsaW50LWRpc2FibGUgY2FtZWxjYXNlICovXG5cbmltcG9ydCB7IGVuY29kZSB9IGZyb20gJ2VtYWlsanMtYmFzZTY0J1xuaW1wb3J0IFRDUFNvY2tldCBmcm9tICdlbWFpbGpzLXRjcC1zb2NrZXQnXG5pbXBvcnQgeyBUZXh0RGVjb2RlciwgVGV4dEVuY29kZXIgfSBmcm9tICd0ZXh0LWVuY29kaW5nJ1xuaW1wb3J0IFNtdHBDbGllbnRSZXNwb25zZVBhcnNlciBmcm9tICcuL3BhcnNlcidcbmltcG9ydCBjcmVhdGVEZWZhdWx0TG9nZ2VyIGZyb20gJy4vbG9nZ2VyJ1xuaW1wb3J0IHtcbiAgTE9HX0xFVkVMX0VSUk9SLFxuICBMT0dfTEVWRUxfV0FSTixcbiAgTE9HX0xFVkVMX0lORk8sXG4gIExPR19MRVZFTF9ERUJVR1xufSBmcm9tICcuL2NvbW1vbidcblxudmFyIERFQlVHX1RBRyA9ICdTTVRQIENsaWVudCdcblxuLyoqXG4gKiBMb3dlciBCb3VuZCBmb3Igc29ja2V0IHRpbWVvdXQgdG8gd2FpdCBzaW5jZSB0aGUgbGFzdCBkYXRhIHdhcyB3cml0dGVuIHRvIGEgc29ja2V0XG4gKi9cbmNvbnN0IFRJTUVPVVRfU09DS0VUX0xPV0VSX0JPVU5EID0gMTAwMDBcblxuLyoqXG4gKiBNdWx0aXBsaWVyIGZvciBzb2NrZXQgdGltZW91dDpcbiAqXG4gKiBXZSBhc3N1bWUgYXQgbGVhc3QgYSBHUFJTIGNvbm5lY3Rpb24gd2l0aCAxMTUga2IvcyA9IDE0LDM3NSBrQi9zIHRvcHMsIHNvIDEwIEtCL3MgdG8gYmUgb25cbiAqIHRoZSBzYWZlIHNpZGUuIFdlIGNhbiB0aW1lb3V0IGFmdGVyIGEgbG93ZXIgYm91bmQgb2YgMTBzICsgKG4gS0IgLyAxMCBLQi9zKS4gQSAxIE1CIG1lc3NhZ2VcbiAqIHVwbG9hZCB3b3VsZCBiZSAxMTAgc2Vjb25kcyB0byB3YWl0IGZvciB0aGUgdGltZW91dC4gMTAgS0IvcyA9PT0gMC4xIHMvQlxuICovXG5jb25zdCBUSU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSID0gMC4xXG5cbmNsYXNzIFNtdHBDbGllbnQge1xuICAvKipcbiAgICogQ3JlYXRlcyBhIGNvbm5lY3Rpb24gb2JqZWN0IHRvIGEgU01UUCBzZXJ2ZXIgYW5kIGFsbG93cyB0byBzZW5kIG1haWwgdGhyb3VnaCBpdC5cbiAgICogQ2FsbCBgY29ubmVjdGAgbWV0aG9kIHRvIGluaXRpdGF0ZSB0aGUgYWN0dWFsIGNvbm5lY3Rpb24sIHRoZSBjb25zdHJ1Y3RvciBvbmx5XG4gICAqIGRlZmluZXMgdGhlIHByb3BlcnRpZXMgYnV0IGRvZXMgbm90IGFjdHVhbGx5IGNvbm5lY3QuXG4gICAqXG4gICAqIE5CISBUaGUgcGFyYW1ldGVyIG9yZGVyIChob3N0LCBwb3J0KSBkaWZmZXJzIGZyb20gbm9kZS5qcyBcIndheVwiIChwb3J0LCBob3N0KVxuICAgKlxuICAgKiBAY29uc3RydWN0b3JcbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IFtob3N0PVwibG9jYWxob3N0XCJdIEhvc3RuYW1lIHRvIGNvbmVuY3QgdG9cbiAgICogQHBhcmFtIHtOdW1iZXJ9IFtwb3J0PTI1XSBQb3J0IG51bWJlciB0byBjb25uZWN0IHRvXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gT3B0aW9uYWwgb3B0aW9ucyBvYmplY3RcbiAgICogQHBhcmFtIHtCb29sZWFufSBbb3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnRdIFNldCB0byB0cnVlLCB0byB1c2UgZW5jcnlwdGVkIGNvbm5lY3Rpb25cbiAgICogQHBhcmFtIHtTdHJpbmd9IFtvcHRpb25zLm5hbWVdIENsaWVudCBob3N0bmFtZSBmb3IgaW50cm9kdWNpbmcgaXRzZWxmIHRvIHRoZSBzZXJ2ZXJcbiAgICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zLmF1dGhdIEF1dGhlbnRpY2F0aW9uIG9wdGlvbnMuIERlcGVuZHMgb24gdGhlIHByZWZlcnJlZCBhdXRoZW50aWNhdGlvbiBtZXRob2QuIFVzdWFsbHkge3VzZXIsIHBhc3N9XG4gICAqIEBwYXJhbSB7U3RyaW5nfSBbb3B0aW9ucy5hdXRoTWV0aG9kXSBGb3JjZSBzcGVjaWZpYyBhdXRoZW50aWNhdGlvbiBtZXRob2RcbiAgICogQHBhcmFtIHtCb29sZWFufSBbb3B0aW9ucy5kaXNhYmxlRXNjYXBpbmddIElmIHNldCB0byB0cnVlLCBkbyBub3QgZXNjYXBlIGRvdHMgb24gdGhlIGJlZ2lubmluZyBvZiB0aGUgbGluZXNcbiAgICovXG4gIGNvbnN0cnVjdG9yIChob3N0LCBwb3J0LCBvcHRpb25zID0ge30pIHtcbiAgICB0aGlzLnRpbWVvdXRTb2NrZXRMb3dlckJvdW5kID0gVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkRcbiAgICB0aGlzLnRpbWVvdXRTb2NrZXRNdWx0aXBsaWVyID0gVElNRU9VVF9TT0NLRVRfTVVMVElQTElFUlxuXG4gICAgdGhpcy5wb3J0ID0gcG9ydCB8fCAodGhpcy5vcHRpb25zLnVzZVNlY3VyZVRyYW5zcG9ydCA/IDQ2NSA6IDI1KVxuICAgIHRoaXMuaG9zdCA9IGhvc3QgfHwgJ2xvY2FsaG9zdCdcblxuICAgIHRoaXMub3B0aW9ucyA9IG9wdGlvbnNcbiAgICAvKipcbiAgICAgKiBJZiBzZXQgdG8gdHJ1ZSwgc3RhcnQgYW4gZW5jcnlwdGVkIGNvbm5lY3Rpb24gaW5zdGVhZCBvZiB0aGUgcGxhaW50ZXh0IG9uZVxuICAgICAqIChyZWNvbW1lbmRlZCBpZiBhcHBsaWNhYmxlKS4gSWYgdXNlU2VjdXJlVHJhbnNwb3J0IGlzIG5vdCBzZXQgYnV0IHRoZSBwb3J0IHVzZWQgaXMgNDY1LFxuICAgICAqIHRoZW4gZWNyeXB0aW9uIGlzIHVzZWQgYnkgZGVmYXVsdC5cbiAgICAgKi9cbiAgICB0aGlzLm9wdGlvbnMudXNlU2VjdXJlVHJhbnNwb3J0ID0gJ3VzZVNlY3VyZVRyYW5zcG9ydCcgaW4gdGhpcy5vcHRpb25zID8gISF0aGlzLm9wdGlvbnMudXNlU2VjdXJlVHJhbnNwb3J0IDogdGhpcy5wb3J0ID09PSA0NjVcblxuICAgIHRoaXMub3B0aW9ucy5hdXRoID0gdGhpcy5vcHRpb25zLmF1dGggfHwgZmFsc2UgLy8gQXV0aGVudGljYXRpb24gb2JqZWN0LiBJZiBub3Qgc2V0LCBhdXRoZW50aWNhdGlvbiBzdGVwIHdpbGwgYmUgc2tpcHBlZC5cbiAgICB0aGlzLm9wdGlvbnMubmFtZSA9IHRoaXMub3B0aW9ucy5uYW1lIHx8ICdsb2NhbGhvc3QnIC8vIEhvc3RuYW1lIG9mIHRoZSBjbGllbnQsIHRoaXMgd2lsbCBiZSB1c2VkIGZvciBpbnRyb2R1Y2luZyB0byB0aGUgc2VydmVyXG4gICAgdGhpcy5zb2NrZXQgPSBmYWxzZSAvLyBEb3duc3RyZWFtIFRDUCBzb2NrZXQgdG8gdGhlIFNNVFAgc2VydmVyLCBjcmVhdGVkIHdpdGggbW96VENQU29ja2V0XG4gICAgdGhpcy5kZXN0cm95ZWQgPSBmYWxzZSAvLyBJbmRpY2F0ZXMgaWYgdGhlIGNvbm5lY3Rpb24gaGFzIGJlZW4gY2xvc2VkIGFuZCBjYW4ndCBiZSB1c2VkIGFueW1vcmVcbiAgICB0aGlzLndhaXREcmFpbiA9IGZhbHNlIC8vIEtlZXBzIHRyYWNrIGlmIHRoZSBkb3duc3RyZWFtIHNvY2tldCBpcyBjdXJyZW50bHkgZnVsbCBhbmQgYSBkcmFpbiBldmVudCBzaG91bGQgYmUgd2FpdGVkIGZvciBvciBub3RcblxuICAgIC8vIFByaXZhdGUgcHJvcGVydGllc1xuXG4gICAgdGhpcy5fcGFyc2VyID0gbmV3IFNtdHBDbGllbnRSZXNwb25zZVBhcnNlcigpIC8vIFNNVFAgcmVzcG9uc2UgcGFyc2VyIG9iamVjdC4gQWxsIGRhdGEgY29taW5nIGZyb20gdGhlIGRvd25zdHJlYW0gc2VydmVyIGlzIGZlZWRlZCB0byB0aGlzIHBhcnNlclxuICAgIHRoaXMuX2F1dGhlbnRpY2F0ZWRBcyA9IG51bGwgLy8gSWYgYXV0aGVudGljYXRlZCBzdWNjZXNzZnVsbHksIHN0b3JlcyB0aGUgdXNlcm5hbWVcbiAgICB0aGlzLl9zdXBwb3J0ZWRBdXRoID0gW10gLy8gQSBsaXN0IG9mIGF1dGhlbnRpY2F0aW9uIG1lY2hhbmlzbXMgZGV0ZWN0ZWQgZnJvbSB0aGUgRUhMTyByZXNwb25zZSBhbmQgd2hpY2ggYXJlIGNvbXBhdGlibGUgd2l0aCB0aGlzIGxpYnJhcnlcbiAgICB0aGlzLl9kYXRhTW9kZSA9IGZhbHNlIC8vIElmIHRydWUsIGFjY2VwdHMgZGF0YSBmcm9tIHRoZSB1cHN0cmVhbSB0byBiZSBwYXNzZWQgZGlyZWN0bHkgdG8gdGhlIGRvd25zdHJlYW0gc29ja2V0LiBVc2VkIGFmdGVyIHRoZSBEQVRBIGNvbW1hbmRcbiAgICB0aGlzLl9sYXN0RGF0YUJ5dGVzID0gJycgLy8gS2VlcCB0cmFjayBvZiB0aGUgbGFzdCBieXRlcyB0byBzZWUgaG93IHRoZSB0ZXJtaW5hdGluZyBkb3Qgc2hvdWxkIGJlIHBsYWNlZFxuICAgIHRoaXMuX2VudmVsb3BlID0gbnVsbCAvLyBFbnZlbG9wZSBvYmplY3QgZm9yIHRyYWNraW5nIHdobyBpcyBzZW5kaW5nIG1haWwgdG8gd2hvbVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSBudWxsIC8vIFN0b3JlcyB0aGUgZnVuY3Rpb24gdGhhdCBzaG91bGQgYmUgcnVuIGFmdGVyIGEgcmVzcG9uc2UgaGFzIGJlZW4gcmVjZWl2ZWQgZnJvbSB0aGUgc2VydmVyXG4gICAgdGhpcy5fc2VjdXJlTW9kZSA9ICEhdGhpcy5vcHRpb25zLnVzZVNlY3VyZVRyYW5zcG9ydCAvLyBJbmRpY2F0ZXMgaWYgdGhlIGNvbm5lY3Rpb24gaXMgc2VjdXJlZCBvciBwbGFpbnRleHRcbiAgICB0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIgPSBmYWxzZSAvLyBUaW1lciB3YWl0aW5nIHRvIGRlY2xhcmUgdGhlIHNvY2tldCBkZWFkIHN0YXJ0aW5nIGZyb20gdGhlIGxhc3Qgd3JpdGVcbiAgICB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgPSBmYWxzZSAvLyBTdGFydCB0aW1lIG9mIHNlbmRpbmcgdGhlIGZpcnN0IHBhY2tldCBpbiBkYXRhIG1vZGVcbiAgICB0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kID0gZmFsc2UgLy8gVGltZW91dCBmb3Igc2VuZGluZyBpbiBkYXRhIG1vZGUsIGdldHMgZXh0ZW5kZWQgd2l0aCBldmVyeSBzZW5kKClcblxuICAgIC8vIEFjdGl2YXRlIGxvZ2dpbmdcbiAgICB0aGlzLmNyZWF0ZUxvZ2dlcigpXG5cbiAgICAvLyBFdmVudCBwbGFjZWhvbGRlcnNcbiAgICB0aGlzLm9uZXJyb3IgPSAoZSkgPT4geyB9IC8vIFdpbGwgYmUgcnVuIHdoZW4gYW4gZXJyb3Igb2NjdXJzLiBUaGUgYG9uY2xvc2VgIGV2ZW50IHdpbGwgZmlyZSBzdWJzZXF1ZW50bHkuXG4gICAgdGhpcy5vbmRyYWluID0gKCkgPT4geyB9IC8vIE1vcmUgZGF0YSBjYW4gYmUgYnVmZmVyZWQgaW4gdGhlIHNvY2tldC5cbiAgICB0aGlzLm9uY2xvc2UgPSAoKSA9PiB7IH0gLy8gVGhlIGNvbm5lY3Rpb24gdG8gdGhlIHNlcnZlciBoYXMgYmVlbiBjbG9zZWRcbiAgICB0aGlzLm9uaWRsZSA9ICgpID0+IHsgfSAvLyBUaGUgY29ubmVjdGlvbiBpcyBlc3RhYmxpc2hlZCBhbmQgaWRsZSwgeW91IGNhbiBzZW5kIG1haWwgbm93XG4gICAgdGhpcy5vbnJlYWR5ID0gKGZhaWxlZFJlY2lwaWVudHMpID0+IHsgfSAvLyBXYWl0aW5nIGZvciBtYWlsIGJvZHksIGxpc3RzIGFkZHJlc3NlcyB0aGF0IHdlcmUgbm90IGFjY2VwdGVkIGFzIHJlY2lwaWVudHNcbiAgICB0aGlzLm9uZG9uZSA9IChzdWNjZXNzKSA9PiB7IH0gLy8gVGhlIG1haWwgaGFzIGJlZW4gc2VudC4gV2FpdCBmb3IgYG9uaWRsZWAgbmV4dC4gSW5kaWNhdGVzIGlmIHRoZSBtZXNzYWdlIHdhcyBxdWV1ZWQgYnkgdGhlIHNlcnZlci5cbiAgfVxuXG4gIC8qKlxuICAgKiBJbml0aWF0ZSBhIGNvbm5lY3Rpb24gdG8gdGhlIHNlcnZlclxuICAgKi9cbiAgY29ubmVjdCAoU29ja2V0Q29udHJ1Y3RvciA9IFRDUFNvY2tldCkge1xuICAgIHRoaXMuc29ja2V0ID0gU29ja2V0Q29udHJ1Y3Rvci5vcGVuKHRoaXMuaG9zdCwgdGhpcy5wb3J0LCB7XG4gICAgICBiaW5hcnlUeXBlOiAnYXJyYXlidWZmZXInLFxuICAgICAgdXNlU2VjdXJlVHJhbnNwb3J0OiB0aGlzLl9zZWN1cmVNb2RlLFxuICAgICAgY2E6IHRoaXMub3B0aW9ucy5jYSxcbiAgICAgIHRsc1dvcmtlclBhdGg6IHRoaXMub3B0aW9ucy50bHNXb3JrZXJQYXRoLFxuICAgICAgd3M6IHRoaXMub3B0aW9ucy53c1xuICAgIH0pXG5cbiAgICAvLyBhbGxvd3MgY2VydGlmaWNhdGUgaGFuZGxpbmcgZm9yIHBsYXRmb3JtIHcvbyBuYXRpdmUgdGxzIHN1cHBvcnRcbiAgICAvLyBvbmNlcnQgaXMgbm9uIHN0YW5kYXJkIHNvIHNldHRpbmcgaXQgbWlnaHQgdGhyb3cgaWYgdGhlIHNvY2tldCBvYmplY3QgaXMgaW1tdXRhYmxlXG4gICAgdHJ5IHtcbiAgICAgIHRoaXMuc29ja2V0Lm9uY2VydCA9IHRoaXMub25jZXJ0XG4gICAgfSBjYXRjaCAoRSkgeyB9XG4gICAgdGhpcy5zb2NrZXQub25lcnJvciA9IHRoaXMuX29uRXJyb3IuYmluZCh0aGlzKVxuICAgIHRoaXMuc29ja2V0Lm9ub3BlbiA9IHRoaXMuX29uT3Blbi5iaW5kKHRoaXMpXG4gIH1cblxuICAvKipcbiAgICogUGF1c2VzIGBkYXRhYCBldmVudHMgZnJvbSB0aGUgZG93bnN0cmVhbSBTTVRQIHNlcnZlclxuICAgKi9cbiAgc3VzcGVuZCAoKSB7XG4gICAgaWYgKHRoaXMuc29ja2V0ICYmIHRoaXMuc29ja2V0LnJlYWR5U3RhdGUgPT09ICdvcGVuJykge1xuICAgICAgdGhpcy5zb2NrZXQuc3VzcGVuZCgpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3VtZXMgYGRhdGFgIGV2ZW50cyBmcm9tIHRoZSBkb3duc3RyZWFtIFNNVFAgc2VydmVyLiBCZSBjYXJlZnVsIG9mIG5vdFxuICAgKiByZXN1bWluZyBzb21ldGhpbmcgdGhhdCBpcyBub3Qgc3VzcGVuZGVkIC0gYW4gZXJyb3IgaXMgdGhyb3duIGluIHRoaXMgY2FzZVxuICAgKi9cbiAgcmVzdW1lICgpIHtcbiAgICBpZiAodGhpcy5zb2NrZXQgJiYgdGhpcy5zb2NrZXQucmVhZHlTdGF0ZSA9PT0gJ29wZW4nKSB7XG4gICAgICB0aGlzLnNvY2tldC5yZXN1bWUoKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBTZW5kcyBRVUlUXG4gICAqL1xuICBxdWl0ICgpIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIFFVSVQuLi4nKVxuICAgIHRoaXMuX3NlbmRDb21tYW5kKCdRVUlUJylcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5jbG9zZVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc2V0IGF1dGhlbnRpY2F0aW9uXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBbYXV0aF0gVXNlIHRoaXMgaWYgeW91IHdhbnQgdG8gYXV0aGVudGljYXRlIGFzIGFub3RoZXIgdXNlclxuICAgKi9cbiAgcmVzZXQgKGF1dGgpIHtcbiAgICB0aGlzLm9wdGlvbnMuYXV0aCA9IGF1dGggfHwgdGhpcy5vcHRpb25zLmF1dGhcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIFJTRVQuLi4nKVxuICAgIHRoaXMuX3NlbmRDb21tYW5kKCdSU0VUJylcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uUlNFVFxuICB9XG5cbiAgLyoqXG4gICAqIENsb3NlcyB0aGUgY29ubmVjdGlvbiB0byB0aGUgc2VydmVyXG4gICAqL1xuICBjbG9zZSAoKSB7XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQ2xvc2luZyBjb25uZWN0aW9uLi4uJylcbiAgICBpZiAodGhpcy5zb2NrZXQgJiYgdGhpcy5zb2NrZXQucmVhZHlTdGF0ZSA9PT0gJ29wZW4nKSB7XG4gICAgICB0aGlzLnNvY2tldC5jbG9zZSgpXG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuX2Rlc3Ryb3koKVxuICAgIH1cbiAgfVxuXG4gIC8vIE1haWwgcmVsYXRlZCBtZXRob2RzXG5cbiAgLyoqXG4gICAqIEluaXRpYXRlcyBhIG5ldyBtZXNzYWdlIGJ5IHN1Ym1pdHRpbmcgZW52ZWxvcGUgZGF0YSwgc3RhcnRpbmcgd2l0aFxuICAgKiBgTUFJTCBGUk9NOmAgY29tbWFuZC4gVXNlIGFmdGVyIGBvbmlkbGVgIGV2ZW50XG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBlbnZlbG9wZSBFbnZlbG9wZSBvYmplY3QgaW4gdGhlIGZvcm0gb2Yge2Zyb206XCIuLi5cIiwgdG86W1wiLi4uXCJdfVxuICAgKi9cbiAgdXNlRW52ZWxvcGUgKGVudmVsb3BlKSB7XG4gICAgdGhpcy5fZW52ZWxvcGUgPSBlbnZlbG9wZSB8fCB7fVxuICAgIHRoaXMuX2VudmVsb3BlLmZyb20gPSBbXS5jb25jYXQodGhpcy5fZW52ZWxvcGUuZnJvbSB8fCAoJ2Fub255bW91c0AnICsgdGhpcy5vcHRpb25zLm5hbWUpKVswXVxuICAgIHRoaXMuX2VudmVsb3BlLnRvID0gW10uY29uY2F0KHRoaXMuX2VudmVsb3BlLnRvIHx8IFtdKVxuXG4gICAgLy8gY2xvbmUgdGhlIHJlY2lwaWVudHMgYXJyYXkgZm9yIGxhdHRlciBtYW5pcHVsYXRpb25cbiAgICB0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUgPSBbXS5jb25jYXQodGhpcy5fZW52ZWxvcGUudG8pXG4gICAgdGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZCA9IFtdXG4gICAgdGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZSA9IFtdXG5cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uTUFJTFxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgTUFJTCBGUk9NLi4uJylcbiAgICB0aGlzLl9zZW5kQ29tbWFuZCgnTUFJTCBGUk9NOjwnICsgKHRoaXMuX2VudmVsb3BlLmZyb20pICsgJz4nKVxuICB9XG5cbiAgLyoqXG4gICAqIFNlbmQgQVNDSUkgZGF0YSB0byB0aGUgc2VydmVyLiBXb3JrcyBvbmx5IGluIGRhdGEgbW9kZSAoYWZ0ZXIgYG9ucmVhZHlgIGV2ZW50KSwgaWdub3JlZFxuICAgKiBvdGhlcndpc2VcbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IGNodW5rIEFTQ0lJIHN0cmluZyAocXVvdGVkLXByaW50YWJsZSwgYmFzZTY0IGV0Yy4pIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICAgKiBAcmV0dXJuIHtCb29sZWFufSBJZiB0cnVlLCBpdCBpcyBzYWZlIHRvIHNlbmQgbW9yZSBkYXRhLCBpZiBmYWxzZSwgeW91ICpzaG91bGQqIHdhaXQgZm9yIHRoZSBvbmRyYWluIGV2ZW50IGJlZm9yZSBzZW5kaW5nIG1vcmVcbiAgICovXG4gIHNlbmQgKGNodW5rKSB7XG4gICAgLy8gd29ya3Mgb25seSBpbiBkYXRhIG1vZGVcbiAgICBpZiAoIXRoaXMuX2RhdGFNb2RlKSB7XG4gICAgICAvLyB0aGlzIGxpbmUgc2hvdWxkIG5ldmVyIGJlIHJlYWNoZWQgYnV0IGlmIGl0IGRvZXMsXG4gICAgICAvLyBhY3QgbGlrZSBldmVyeXRoaW5nJ3Mgbm9ybWFsLlxuICAgICAgcmV0dXJuIHRydWVcbiAgICB9XG5cbiAgICAvLyBUT0RPOiBpZiB0aGUgY2h1bmsgaXMgYW4gYXJyYXlidWZmZXIsIHVzZSBhIHNlcGFyYXRlIGZ1bmN0aW9uIHRvIHNlbmQgdGhlIGRhdGFcbiAgICByZXR1cm4gdGhpcy5fc2VuZFN0cmluZyhjaHVuaylcbiAgfVxuXG4gIC8qKlxuICAgKiBJbmRpY2F0ZXMgdGhhdCBhIGRhdGEgc3RyZWFtIGZvciB0aGUgc29ja2V0IGlzIGVuZGVkLiBXb3JrcyBvbmx5IGluIGRhdGFcbiAgICogbW9kZSAoYWZ0ZXIgYG9ucmVhZHlgIGV2ZW50KSwgaWdub3JlZCBvdGhlcndpc2UuIFVzZSBpdCB3aGVuIHlvdSBhcmUgZG9uZVxuICAgKiB3aXRoIHNlbmRpbmcgdGhlIG1haWwuIFRoaXMgbWV0aG9kIGRvZXMgbm90IGNsb3NlIHRoZSBzb2NrZXQuIE9uY2UgdGhlIG1haWxcbiAgICogaGFzIGJlZW4gcXVldWVkIGJ5IHRoZSBzZXJ2ZXIsIGBvbmRvbmVgIGFuZCBgb25pZGxlYCBhcmUgZW1pdHRlZC5cbiAgICpcbiAgICogQHBhcmFtIHtCdWZmZXJ9IFtjaHVua10gQ2h1bmsgb2YgZGF0YSB0byBiZSBzZW50IHRvIHRoZSBzZXJ2ZXJcbiAgICovXG4gIGVuZCAoY2h1bmspIHtcbiAgICAvLyB3b3JrcyBvbmx5IGluIGRhdGEgbW9kZVxuICAgIGlmICghdGhpcy5fZGF0YU1vZGUpIHtcbiAgICAgIC8vIHRoaXMgbGluZSBzaG91bGQgbmV2ZXIgYmUgcmVhY2hlZCBidXQgaWYgaXQgZG9lcyxcbiAgICAgIC8vIGFjdCBsaWtlIGV2ZXJ5dGhpbmcncyBub3JtYWwuXG4gICAgICByZXR1cm4gdHJ1ZVxuICAgIH1cblxuICAgIGlmIChjaHVuayAmJiBjaHVuay5sZW5ndGgpIHtcbiAgICAgIHRoaXMuc2VuZChjaHVuaylcbiAgICB9XG5cbiAgICAvLyByZWRpcmVjdCBvdXRwdXQgZnJvbSB0aGUgc2VydmVyIHRvIF9hY3Rpb25TdHJlYW1cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uU3RyZWFtXG5cbiAgICAvLyBpbmRpY2F0ZSB0aGF0IHRoZSBzdHJlYW0gaGFzIGVuZGVkIGJ5IHNlbmRpbmcgYSBzaW5nbGUgZG90IG9uIGl0cyBvd24gbGluZVxuICAgIC8vIGlmIHRoZSBjbGllbnQgYWxyZWFkeSBjbG9zZWQgdGhlIGRhdGEgd2l0aCBcXHJcXG4gbm8gbmVlZCB0byBkbyBpdCBhZ2FpblxuICAgIGlmICh0aGlzLl9sYXN0RGF0YUJ5dGVzID09PSAnXFxyXFxuJykge1xuICAgICAgdGhpcy53YWl0RHJhaW4gPSB0aGlzLl9zZW5kKG5ldyBVaW50OEFycmF5KFsweDJFLCAweDBELCAweDBBXSkuYnVmZmVyKSAvLyAuXFxyXFxuXG4gICAgfSBlbHNlIGlmICh0aGlzLl9sYXN0RGF0YUJ5dGVzLnN1YnN0cigtMSkgPT09ICdcXHInKSB7XG4gICAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFVpbnQ4QXJyYXkoWzB4MEEsIDB4MkUsIDB4MEQsIDB4MEFdKS5idWZmZXIpIC8vIFxcbi5cXHJcXG5cbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy53YWl0RHJhaW4gPSB0aGlzLl9zZW5kKG5ldyBVaW50OEFycmF5KFsweDBELCAweDBBLCAweDJFLCAweDBELCAweDBBXSkuYnVmZmVyKSAvLyBcXHJcXG4uXFxyXFxuXG4gICAgfVxuXG4gICAgLy8gZW5kIGRhdGEgbW9kZSwgcmVzZXQgdGhlIHZhcmlhYmxlcyBmb3IgZXh0ZW5kaW5nIHRoZSB0aW1lb3V0IGluIGRhdGEgbW9kZVxuICAgIHRoaXMuX2RhdGFNb2RlID0gZmFsc2VcbiAgICB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgPSBmYWxzZVxuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgPSBmYWxzZVxuXG4gICAgcmV0dXJuIHRoaXMud2FpdERyYWluXG4gIH1cblxuICAvLyBQUklWQVRFIE1FVEhPRFNcblxuICAvLyBFVkVOVCBIQU5ETEVSUyBGT1IgVEhFIFNPQ0tFVFxuXG4gIC8qKlxuICAgKiBDb25uZWN0aW9uIGxpc3RlbmVyIHRoYXQgaXMgcnVuIHdoZW4gdGhlIGNvbm5lY3Rpb24gdG8gdGhlIHNlcnZlciBpcyBvcGVuZWQuXG4gICAqIFNldHMgdXAgZGlmZmVyZW50IGV2ZW50IGhhbmRsZXJzIGZvciB0aGUgb3BlbmVkIHNvY2tldFxuICAgKlxuICAgKiBAZXZlbnRcbiAgICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gTm90IHVzZWRcbiAgICovXG4gIF9vbk9wZW4gKGV2ZW50KSB7XG4gICAgaWYgKGV2ZW50ICYmIGV2ZW50LmRhdGEgJiYgZXZlbnQuZGF0YS5wcm94eUhvc3RuYW1lKSB7XG4gICAgICB0aGlzLm9wdGlvbnMubmFtZSA9IGV2ZW50LmRhdGEucHJveHlIb3N0bmFtZVxuICAgIH1cblxuICAgIHRoaXMuc29ja2V0Lm9uZGF0YSA9IHRoaXMuX29uRGF0YS5iaW5kKHRoaXMpXG5cbiAgICB0aGlzLnNvY2tldC5vbmNsb3NlID0gdGhpcy5fb25DbG9zZS5iaW5kKHRoaXMpXG4gICAgdGhpcy5zb2NrZXQub25kcmFpbiA9IHRoaXMuX29uRHJhaW4uYmluZCh0aGlzKVxuXG4gICAgdGhpcy5fcGFyc2VyLm9uZGF0YSA9IHRoaXMuX29uQ29tbWFuZC5iaW5kKHRoaXMpXG5cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uR3JlZXRpbmdcbiAgfVxuXG4gIC8qKlxuICAgKiBEYXRhIGxpc3RlbmVyIGZvciBjaHVua3Mgb2YgZGF0YSBlbWl0dGVkIGJ5IHRoZSBzZXJ2ZXJcbiAgICpcbiAgICogQGV2ZW50XG4gICAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIFNlZSBgZXZ0LmRhdGFgIGZvciB0aGUgY2h1bmsgcmVjZWl2ZWRcbiAgICovXG4gIF9vbkRhdGEgKGV2dCkge1xuICAgIGNsZWFyVGltZW91dCh0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIpXG4gICAgdmFyIHN0cmluZ1BheWxvYWQgPSBuZXcgVGV4dERlY29kZXIoJ1VURi04JykuZGVjb2RlKG5ldyBVaW50OEFycmF5KGV2dC5kYXRhKSlcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTRVJWRVI6ICcgKyBzdHJpbmdQYXlsb2FkKVxuICAgIHRoaXMuX3BhcnNlci5zZW5kKHN0cmluZ1BheWxvYWQpXG4gIH1cblxuICAvKipcbiAgICogTW9yZSBkYXRhIGNhbiBiZSBidWZmZXJlZCBpbiB0aGUgc29ja2V0LCBgd2FpdERyYWluYCBpcyByZXNldCB0byBmYWxzZVxuICAgKlxuICAgKiBAZXZlbnRcbiAgICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gTm90IHVzZWRcbiAgICovXG4gIF9vbkRyYWluICgpIHtcbiAgICB0aGlzLndhaXREcmFpbiA9IGZhbHNlXG4gICAgdGhpcy5vbmRyYWluKClcbiAgfVxuXG4gIC8qKlxuICAgKiBFcnJvciBoYW5kbGVyIGZvciB0aGUgc29ja2V0XG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBTZWUgZXZ0LmRhdGEgZm9yIHRoZSBlcnJvclxuICAgKi9cbiAgX29uRXJyb3IgKGV2dCkge1xuICAgIGlmIChldnQgaW5zdGFuY2VvZiBFcnJvciAmJiBldnQubWVzc2FnZSkge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCBldnQpXG4gICAgICB0aGlzLm9uZXJyb3IoZXZ0KVxuICAgIH0gZWxzZSBpZiAoZXZ0ICYmIGV2dC5kYXRhIGluc3RhbmNlb2YgRXJyb3IpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgZXZ0LmRhdGEpXG4gICAgICB0aGlzLm9uZXJyb3IoZXZ0LmRhdGEpXG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgbmV3IEVycm9yKChldnQgJiYgZXZ0LmRhdGEgJiYgZXZ0LmRhdGEubWVzc2FnZSkgfHwgZXZ0LmRhdGEgfHwgZXZ0IHx8ICdFcnJvcicpKVxuICAgICAgdGhpcy5vbmVycm9yKG5ldyBFcnJvcigoZXZ0ICYmIGV2dC5kYXRhICYmIGV2dC5kYXRhLm1lc3NhZ2UpIHx8IGV2dC5kYXRhIHx8IGV2dCB8fCAnRXJyb3InKSlcbiAgICB9XG5cbiAgICB0aGlzLmNsb3NlKClcbiAgfVxuXG4gIC8qKlxuICAgKiBJbmRpY2F0ZXMgdGhhdCB0aGUgc29ja2V0IGhhcyBiZWVuIGNsb3NlZFxuICAgKlxuICAgKiBAZXZlbnRcbiAgICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gTm90IHVzZWRcbiAgICovXG4gIF9vbkNsb3NlICgpIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTb2NrZXQgY2xvc2VkLicpXG4gICAgdGhpcy5fZGVzdHJveSgpXG4gIH1cblxuICAvKipcbiAgICogVGhpcyBpcyBub3QgYSBzb2NrZXQgZGF0YSBoYW5kbGVyIGJ1dCB0aGUgaGFuZGxlciBmb3IgZGF0YSBlbWl0dGVkIGJ5IHRoZSBwYXJzZXIsXG4gICAqIHNvIHRoaXMgZGF0YSBpcyBzYWZlIHRvIHVzZSBhcyBpdCBpcyBhbHdheXMgY29tcGxldGUgKHNlcnZlciBtaWdodCBzZW5kIHBhcnRpYWwgY2h1bmtzKVxuICAgKlxuICAgKiBAZXZlbnRcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGRhdGFcbiAgICovXG4gIF9vbkNvbW1hbmQgKGNvbW1hbmQpIHtcbiAgICBpZiAodHlwZW9mIHRoaXMuX2N1cnJlbnRBY3Rpb24gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24oY29tbWFuZClcbiAgICB9XG4gIH1cblxuICBfb25UaW1lb3V0ICgpIHtcbiAgICAvLyBpbmZvcm0gYWJvdXQgdGhlIHRpbWVvdXQgYW5kIHNodXQgZG93blxuICAgIHZhciBlcnJvciA9IG5ldyBFcnJvcignU29ja2V0IHRpbWVkIG91dCEnKVxuICAgIHRoaXMuX29uRXJyb3IoZXJyb3IpXG4gIH1cblxuICAvKipcbiAgICogRW5zdXJlcyB0aGF0IHRoZSBjb25uZWN0aW9uIGlzIGNsb3NlZCBhbmQgc3VjaFxuICAgKi9cbiAgX2Rlc3Ryb3kgKCkge1xuICAgIGNsZWFyVGltZW91dCh0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIpXG5cbiAgICBpZiAoIXRoaXMuZGVzdHJveWVkKSB7XG4gICAgICB0aGlzLmRlc3Ryb3llZCA9IHRydWVcbiAgICAgIHRoaXMub25jbG9zZSgpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFNlbmRzIGEgc3RyaW5nIHRvIHRoZSBzb2NrZXQuXG4gICAqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBjaHVuayBBU0NJSSBzdHJpbmcgKHF1b3RlZC1wcmludGFibGUsIGJhc2U2NCBldGMuKSB0byBiZSBzZW50IHRvIHRoZSBzZXJ2ZXJcbiAgICogQHJldHVybiB7Qm9vbGVhbn0gSWYgdHJ1ZSwgaXQgaXMgc2FmZSB0byBzZW5kIG1vcmUgZGF0YSwgaWYgZmFsc2UsIHlvdSAqc2hvdWxkKiB3YWl0IGZvciB0aGUgb25kcmFpbiBldmVudCBiZWZvcmUgc2VuZGluZyBtb3JlXG4gICAqL1xuICBfc2VuZFN0cmluZyAoY2h1bmspIHtcbiAgICAvLyBlc2NhcGUgZG90c1xuICAgIGlmICghdGhpcy5vcHRpb25zLmRpc2FibGVFc2NhcGluZykge1xuICAgICAgY2h1bmsgPSBjaHVuay5yZXBsYWNlKC9cXG5cXC4vZywgJ1xcbi4uJylcbiAgICAgIGlmICgodGhpcy5fbGFzdERhdGFCeXRlcy5zdWJzdHIoLTEpID09PSAnXFxuJyB8fCAhdGhpcy5fbGFzdERhdGFCeXRlcykgJiYgY2h1bmsuY2hhckF0KDApID09PSAnLicpIHtcbiAgICAgICAgY2h1bmsgPSAnLicgKyBjaHVua1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIEtlZXBpbmcgZXllIG9uIHRoZSBsYXN0IGJ5dGVzIHNlbnQsIHRvIHNlZSBpZiB0aGVyZSBpcyBhIDxDUj48TEY+IHNlcXVlbmNlXG4gICAgLy8gYXQgdGhlIGVuZCB3aGljaCBpcyBuZWVkZWQgdG8gZW5kIHRoZSBkYXRhIHN0cmVhbVxuICAgIGlmIChjaHVuay5sZW5ndGggPiAyKSB7XG4gICAgICB0aGlzLl9sYXN0RGF0YUJ5dGVzID0gY2h1bmsuc3Vic3RyKC0yKVxuICAgIH0gZWxzZSBpZiAoY2h1bmsubGVuZ3RoID09PSAxKSB7XG4gICAgICB0aGlzLl9sYXN0RGF0YUJ5dGVzID0gdGhpcy5fbGFzdERhdGFCeXRlcy5zdWJzdHIoLTEpICsgY2h1bmtcbiAgICB9XG5cbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nICcgKyBjaHVuay5sZW5ndGggKyAnIGJ5dGVzIG9mIHBheWxvYWQnKVxuXG4gICAgLy8gcGFzcyB0aGUgY2h1bmsgdG8gdGhlIHNvY2tldFxuICAgIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVGV4dEVuY29kZXIoJ1VURi04JykuZW5jb2RlKGNodW5rKS5idWZmZXIpXG4gICAgcmV0dXJuIHRoaXMud2FpdERyYWluXG4gIH1cblxuICAvKipcbiAgICogU2VuZCBhIHN0cmluZyBjb21tYW5kIHRvIHRoZSBzZXJ2ZXIsIGFsc28gYXBwZW5kIFxcclxcbiBpZiBuZWVkZWRcbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IHN0ciBTdHJpbmcgdG8gYmUgc2VudCB0byB0aGUgc2VydmVyXG4gICAqL1xuICBfc2VuZENvbW1hbmQgKHN0cikge1xuICAgIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVGV4dEVuY29kZXIoJ1VURi04JykuZW5jb2RlKHN0ciArIChzdHIuc3Vic3RyKC0yKSAhPT0gJ1xcclxcbicgPyAnXFxyXFxuJyA6ICcnKSkuYnVmZmVyKVxuICB9XG5cbiAgX3NlbmQgKGJ1ZmZlcikge1xuICAgIHRoaXMuX3NldFRpbWVvdXQoYnVmZmVyLmJ5dGVMZW5ndGgpXG4gICAgcmV0dXJuIHRoaXMuc29ja2V0LnNlbmQoYnVmZmVyKVxuICB9XG5cbiAgX3NldFRpbWVvdXQgKGJ5dGVMZW5ndGgpIHtcbiAgICB2YXIgcHJvbG9uZ1BlcmlvZCA9IE1hdGguZmxvb3IoYnl0ZUxlbmd0aCAqIHRoaXMudGltZW91dFNvY2tldE11bHRpcGxpZXIpXG4gICAgdmFyIHRpbWVvdXRcblxuICAgIGlmICh0aGlzLl9kYXRhTW9kZSkge1xuICAgICAgLy8gd2UncmUgaW4gZGF0YSBtb2RlLCBzbyB3ZSBjb3VudCBvbmx5IG9uZSB0aW1lb3V0IHRoYXQgZ2V0IGV4dGVuZGVkIGZvciBldmVyeSBzZW5kKCkuXG4gICAgICB2YXIgbm93ID0gRGF0ZS5ub3coKVxuXG4gICAgICAvLyB0aGUgb2xkIHRpbWVvdXQgc3RhcnQgdGltZVxuICAgICAgdGhpcy5fc29ja2V0VGltZW91dFN0YXJ0ID0gdGhpcy5fc29ja2V0VGltZW91dFN0YXJ0IHx8IG5vd1xuXG4gICAgICAvLyB0aGUgb2xkIHRpbWVvdXQgcGVyaW9kLCBub3JtYWxpemVkIHRvIGEgbWluaW11bSBvZiBUSU1FT1VUX1NPQ0tFVF9MT1dFUl9CT1VORFxuICAgICAgdGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCA9ICh0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kIHx8IHRoaXMudGltZW91dFNvY2tldExvd2VyQm91bmQpICsgcHJvbG9uZ1BlcmlvZFxuXG4gICAgICAvLyB0aGUgbmV3IHRpbWVvdXQgaXMgdGhlIGRlbHRhIGJldHdlZW4gdGhlIG5ldyBmaXJpbmcgdGltZSAoPSB0aW1lb3V0IHBlcmlvZCArIHRpbWVvdXQgc3RhcnQgdGltZSkgYW5kIG5vd1xuICAgICAgdGltZW91dCA9IHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCArIHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgLSBub3dcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gc2V0IG5ldyB0aW1vdXRcbiAgICAgIHRpbWVvdXQgPSB0aGlzLnRpbWVvdXRTb2NrZXRMb3dlckJvdW5kICsgcHJvbG9uZ1BlcmlvZFxuICAgIH1cblxuICAgIGNsZWFyVGltZW91dCh0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIpIC8vIGNsZWFyIHBlbmRpbmcgdGltZW91dHNcbiAgICB0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIgPSBzZXRUaW1lb3V0KHRoaXMuX29uVGltZW91dC5iaW5kKHRoaXMpLCB0aW1lb3V0KSAvLyBhcm0gdGhlIG5leHQgdGltZW91dFxuICB9XG5cbiAgLyoqXG4gICAqIEludGl0aWF0ZSBhdXRoZW50aWNhdGlvbiBzZXF1ZW5jZSBpZiBuZWVkZWRcbiAgICovXG4gIF9hdXRoZW50aWNhdGVVc2VyICgpIHtcbiAgICBpZiAoIXRoaXMub3B0aW9ucy5hdXRoKSB7XG4gICAgICAvLyBubyBuZWVkIHRvIGF1dGhlbnRpY2F0ZSwgYXQgbGVhc3Qgbm8gZGF0YSBnaXZlblxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICAgIHRoaXMub25pZGxlKCkgLy8gcmVhZHkgdG8gdGFrZSBvcmRlcnNcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHZhciBhdXRoXG5cbiAgICBpZiAoIXRoaXMub3B0aW9ucy5hdXRoTWV0aG9kICYmIHRoaXMub3B0aW9ucy5hdXRoLnhvYXV0aDIpIHtcbiAgICAgIHRoaXMub3B0aW9ucy5hdXRoTWV0aG9kID0gJ1hPQVVUSDInXG4gICAgfVxuXG4gICAgaWYgKHRoaXMub3B0aW9ucy5hdXRoTWV0aG9kKSB7XG4gICAgICBhdXRoID0gdGhpcy5vcHRpb25zLmF1dGhNZXRob2QudG9VcHBlckNhc2UoKS50cmltKClcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gdXNlIGZpcnN0IHN1cHBvcnRlZFxuICAgICAgYXV0aCA9ICh0aGlzLl9zdXBwb3J0ZWRBdXRoWzBdIHx8ICdQTEFJTicpLnRvVXBwZXJDYXNlKCkudHJpbSgpXG4gICAgfVxuXG4gICAgc3dpdGNoIChhdXRoKSB7XG4gICAgICBjYXNlICdMT0dJTic6XG4gICAgICAgIC8vIExPR0lOIGlzIGEgMyBzdGVwIGF1dGhlbnRpY2F0aW9uIHByb2Nlc3NcbiAgICAgICAgLy8gQzogQVVUSCBMT0dJTlxuICAgICAgICAvLyBDOiBCQVNFNjQoVVNFUilcbiAgICAgICAgLy8gQzogQkFTRTY0KFBBU1MpXG4gICAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIHZpYSBBVVRIIExPR0lOJylcbiAgICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhfTE9HSU5fVVNFUlxuICAgICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnQVVUSCBMT0dJTicpXG4gICAgICAgIHJldHVyblxuICAgICAgY2FzZSAnUExBSU4nOlxuICAgICAgICAvLyBBVVRIIFBMQUlOIGlzIGEgMSBzdGVwIGF1dGhlbnRpY2F0aW9uIHByb2Nlc3NcbiAgICAgICAgLy8gQzogQVVUSCBQTEFJTiBCQVNFNjQoXFwwIFVTRVIgXFwwIFBBU1MpXG4gICAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIHZpYSBBVVRIIFBMQUlOJylcbiAgICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhDb21wbGV0ZVxuICAgICAgICB0aGlzLl9zZW5kQ29tbWFuZChcbiAgICAgICAgICAvLyBjb252ZXJ0IHRvIEJBU0U2NFxuICAgICAgICAgICdBVVRIIFBMQUlOICcgK1xuICAgICAgICAgIGVuY29kZShcbiAgICAgICAgICAgIC8vIHRoaXMub3B0aW9ucy5hdXRoLnVzZXIrJ1xcdTAwMDAnK1xuICAgICAgICAgICAgJ1xcdTAwMDAnICsgLy8gc2tpcCBhdXRob3JpemF0aW9uIGlkZW50aXR5IGFzIGl0IGNhdXNlcyBwcm9ibGVtcyB3aXRoIHNvbWUgc2VydmVyc1xuICAgICAgICAgICAgdGhpcy5vcHRpb25zLmF1dGgudXNlciArICdcXHUwMDAwJyArXG4gICAgICAgICAgICB0aGlzLm9wdGlvbnMuYXV0aC5wYXNzKVxuICAgICAgICApXG4gICAgICAgIHJldHVyblxuICAgICAgY2FzZSAnWE9BVVRIMic6XG4gICAgICAgIC8vIFNlZSBodHRwczovL2RldmVsb3BlcnMuZ29vZ2xlLmNvbS9nbWFpbC94b2F1dGgyX3Byb3RvY29sI3NtdHBfcHJvdG9jb2xfZXhjaGFuZ2VcbiAgICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gdmlhIEFVVEggWE9BVVRIMicpXG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIX1hPQVVUSDJcbiAgICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0FVVEggWE9BVVRIMiAnICsgdGhpcy5fYnVpbGRYT0F1dGgyVG9rZW4odGhpcy5vcHRpb25zLmF1dGgudXNlciwgdGhpcy5vcHRpb25zLmF1dGgueG9hdXRoMikpXG4gICAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdVbmtub3duIGF1dGhlbnRpY2F0aW9uIG1ldGhvZCAnICsgYXV0aCkpXG4gIH1cblxuICAvLyBBQ1RJT05TIEZPUiBSRVNQT05TRVMgRlJPTSBUSEUgU01UUCBTRVJWRVJcblxuICAvKipcbiAgICogSW5pdGlhbCByZXNwb25zZSBmcm9tIHRoZSBzZXJ2ZXIsIG11c3QgaGF2ZSBhIHN0YXR1cyAyMjBcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICAgKi9cbiAgX2FjdGlvbkdyZWV0aW5nIChjb21tYW5kKSB7XG4gICAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSAhPT0gMjIwKSB7XG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignSW52YWxpZCBncmVldGluZzogJyArIGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICBpZiAodGhpcy5vcHRpb25zLmxtdHApIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgTEhMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG5cbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25MSExPXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnTEhMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgRUhMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG5cbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25FSExPXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnRUhMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIExITE9cbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICAgKi9cbiAgX2FjdGlvbkxITE8gKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnTEhMTyBub3Qgc3VjY2Vzc2Z1bCcpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gUHJvY2VzcyBhcyBFSExPIHJlc3BvbnNlXG4gICAgdGhpcy5fYWN0aW9uRUhMTyhjb21tYW5kKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIEVITE8uIElmIHRoZSByZXNwb25zZSBpcyBhbiBlcnJvciwgdHJ5IEhFTE8gaW5zdGVhZFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uRUhMTyAoY29tbWFuZCkge1xuICAgIHZhciBtYXRjaFxuXG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIGlmICghdGhpcy5fc2VjdXJlTW9kZSAmJiB0aGlzLm9wdGlvbnMucmVxdWlyZVRMUykge1xuICAgICAgICB2YXIgZXJyTXNnID0gJ1NUQVJUVExTIG5vdCBzdXBwb3J0ZWQgd2l0aG91dCBFSExPJ1xuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsIGVyck1zZylcbiAgICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoZXJyTXNnKSlcbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG5cbiAgICAgIC8vIFRyeSBIRUxPIGluc3RlYWRcbiAgICAgIHRoaXMubG9nZ2VyLndhcm4oREVCVUdfVEFHLCAnRUhMTyBub3Qgc3VjY2Vzc2Z1bCwgdHJ5aW5nIEhFTE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkhFTE9cbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdIRUxPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIC8vIERldGVjdCBpZiB0aGUgc2VydmVyIHN1cHBvcnRzIFBMQUlOIGF1dGhcbiAgICBpZiAoY29tbWFuZC5saW5lLm1hdGNoKC9BVVRIKD86XFxzK1teXFxuXSpcXHMrfFxccyspUExBSU4vaSkpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlcnZlciBzdXBwb3J0cyBBVVRIIFBMQUlOJylcbiAgICAgIHRoaXMuX3N1cHBvcnRlZEF1dGgucHVzaCgnUExBSU4nKVxuICAgIH1cblxuICAgIC8vIERldGVjdCBpZiB0aGUgc2VydmVyIHN1cHBvcnRzIExPR0lOIGF1dGhcbiAgICBpZiAoY29tbWFuZC5saW5lLm1hdGNoKC9BVVRIKD86XFxzK1teXFxuXSpcXHMrfFxccyspTE9HSU4vaSkpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlcnZlciBzdXBwb3J0cyBBVVRIIExPR0lOJylcbiAgICAgIHRoaXMuX3N1cHBvcnRlZEF1dGgucHVzaCgnTE9HSU4nKVxuICAgIH1cblxuICAgIC8vIERldGVjdCBpZiB0aGUgc2VydmVyIHN1cHBvcnRzIFhPQVVUSDIgYXV0aFxuICAgIGlmIChjb21tYW5kLmxpbmUubWF0Y2goL0FVVEgoPzpcXHMrW15cXG5dKlxccyt8XFxzKylYT0FVVEgyL2kpKSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZXJ2ZXIgc3VwcG9ydHMgQVVUSCBYT0FVVEgyJylcbiAgICAgIHRoaXMuX3N1cHBvcnRlZEF1dGgucHVzaCgnWE9BVVRIMicpXG4gICAgfVxuXG4gICAgLy8gRGV0ZWN0IG1heGltdW0gYWxsb3dlZCBtZXNzYWdlIHNpemVcbiAgICBpZiAoKG1hdGNoID0gY29tbWFuZC5saW5lLm1hdGNoKC9TSVpFIChcXGQrKS9pKSkgJiYgTnVtYmVyKG1hdGNoWzFdKSkge1xuICAgICAgY29uc3QgbWF4QWxsb3dlZFNpemUgPSBOdW1iZXIobWF0Y2hbMV0pXG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdNYXhpbXVtIGFsbG93ZCBtZXNzYWdlIHNpemU6ICcgKyBtYXhBbGxvd2VkU2l6ZSlcbiAgICB9XG5cbiAgICAvLyBEZXRlY3QgaWYgdGhlIHNlcnZlciBzdXBwb3J0cyBTVEFSVFRMU1xuICAgIGlmICghdGhpcy5fc2VjdXJlTW9kZSkge1xuICAgICAgaWYgKChjb21tYW5kLmxpbmUubWF0Y2goL1sgLV1TVEFSVFRMU1xccz8kL21pKSAmJiAhdGhpcy5vcHRpb25zLmlnbm9yZVRMUykgfHwgISF0aGlzLm9wdGlvbnMucmVxdWlyZVRMUykge1xuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uU1RBUlRUTFNcbiAgICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBTVEFSVFRMUycpXG4gICAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdTVEFSVFRMUycpXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuX2F1dGhlbnRpY2F0ZVVzZXIoKVxuICB9XG5cbiAgLyoqXG4gICAqIEhhbmRsZXMgc2VydmVyIHJlc3BvbnNlIGZvciBTVEFSVFRMUyBjb21tYW5kLiBJZiB0aGVyZSdzIGFuIGVycm9yXG4gICAqIHRyeSBIRUxPIGluc3RlYWQsIG90aGVyd2lzZSBpbml0aWF0ZSBUTFMgdXBncmFkZS4gSWYgdGhlIHVwZ3JhZGVcbiAgICogc3VjY2VlZGVzIHJlc3RhcnQgdGhlIEVITE9cbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IHN0ciBNZXNzYWdlIGZyb20gdGhlIHNlcnZlclxuICAgKi9cbiAgX2FjdGlvblNUQVJUVExTIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ1NUQVJUVExTIG5vdCBzdWNjZXNzZnVsJylcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLl9zZWN1cmVNb2RlID0gdHJ1ZVxuICAgIHRoaXMuc29ja2V0LnVwZ3JhZGVUb1NlY3VyZSgpXG5cbiAgICAvLyByZXN0YXJ0IHByb3RvY29sIGZsb3dcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uRUhMT1xuICAgIHRoaXMuX3NlbmRDb21tYW5kKCdFSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBIRUxPXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAgICovXG4gIF9hY3Rpb25IRUxPIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0hFTE8gbm90IHN1Y2Nlc3NmdWwnKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cbiAgICB0aGlzLl9hdXRoZW50aWNhdGVVc2VyKClcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBBVVRIIExPR0lOLCBpZiBzdWNjZXNzZnVsIGV4cGVjdHMgYmFzZTY0IGVuY29kZWQgdXNlcm5hbWVcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICAgKi9cbiAgX2FjdGlvbkFVVEhfTE9HSU5fVVNFUiAoY29tbWFuZCkge1xuICAgIGlmIChjb21tYW5kLnN0YXR1c0NvZGUgIT09IDMzNCB8fCBjb21tYW5kLmRhdGEgIT09ICdWWE5sY201aGJXVTYnKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdBVVRIIExPR0lOIFVTRVIgbm90IHN1Y2Nlc3NmdWw6ICcgKyBjb21tYW5kLmRhdGEpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignSW52YWxpZCBsb2dpbiBzZXF1ZW5jZSB3aGlsZSB3YWl0aW5nIGZvciBcIjMzNCBWWE5sY201aGJXVTYgXCI6ICcgKyBjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0FVVEggTE9HSU4gVVNFUiBzdWNjZXNzZnVsJylcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSF9MT0dJTl9QQVNTXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoZW5jb2RlKHRoaXMub3B0aW9ucy5hdXRoLnVzZXIpKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIEFVVEggTE9HSU4gdXNlcm5hbWUsIGlmIHN1Y2Nlc3NmdWwgZXhwZWN0cyBiYXNlNjQgZW5jb2RlZCBwYXNzd29yZFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uQVVUSF9MT0dJTl9QQVNTIChjb21tYW5kKSB7XG4gICAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSAhPT0gMzM0IHx8IGNvbW1hbmQuZGF0YSAhPT0gJ1VHRnpjM2R2Y21RNicpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0FVVEggTE9HSU4gUEFTUyBub3Qgc3VjY2Vzc2Z1bDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdJbnZhbGlkIGxvZ2luIHNlcXVlbmNlIHdoaWxlIHdhaXRpbmcgZm9yIFwiMzM0IFVHRnpjM2R2Y21RNiBcIjogJyArIGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQVVUSCBMT0dJTiBQQVNTIHN1Y2Nlc3NmdWwnKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGVcbiAgICB0aGlzLl9zZW5kQ29tbWFuZChlbmNvZGUodGhpcy5vcHRpb25zLmF1dGgucGFzcykpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gQVVUSCBYT0FVVEgyIHRva2VuLCBpZiBlcnJvciBvY2N1cnMgc2VuZCBlbXB0eSByZXNwb25zZVxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uQVVUSF9YT0FVVEgyIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLndhcm4oREVCVUdfVEFHLCAnRXJyb3IgZHVyaW5nIEFVVEggWE9BVVRIMiwgc2VuZGluZyBlbXB0eSByZXNwb25zZScpXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnJylcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGVcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fYWN0aW9uQVVUSENvbXBsZXRlKGNvbW1hbmQpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIENoZWNrcyBpZiBhdXRoZW50aWNhdGlvbiBzdWNjZWVkZWQgb3Igbm90LiBJZiBzdWNjZXNzZnVsbHkgYXV0aGVudGljYXRlZFxuICAgKiBlbWl0IGBpZGxlYCB0byBpbmRpY2F0ZSB0aGF0IGFuIGUtbWFpbCBjYW4gYmUgc2VudCB1c2luZyB0aGlzIGNvbm5lY3Rpb25cbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICAgKi9cbiAgX2FjdGlvbkFVVEhDb21wbGV0ZSAoY29tbWFuZCkge1xuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiBmYWlsZWQ6ICcgKyBjb21tYW5kLmRhdGEpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gc3VjY2Vzc2Z1bC4nKVxuXG4gICAgdGhpcy5fYXV0aGVudGljYXRlZEFzID0gdGhpcy5vcHRpb25zLmF1dGgudXNlclxuXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICB0aGlzLm9uaWRsZSgpIC8vIHJlYWR5IHRvIHRha2Ugb3JkZXJzXG4gIH1cblxuICAvKipcbiAgICogVXNlZCB3aGVuIHRoZSBjb25uZWN0aW9uIGlzIGlkbGUgYW5kIHRoZSBzZXJ2ZXIgZW1pdHMgdGltZW91dFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uSWRsZSAoY29tbWFuZCkge1xuICAgIGlmIChjb21tYW5kLnN0YXR1c0NvZGUgPiAzMDApIHtcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQubGluZSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIE1BSUwgRlJPTSBjb21tYW5kLiBQcm9jZWVkIHRvIGRlZmluaW5nIFJDUFQgVE8gbGlzdCBpZiBzdWNjZXNzZnVsXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAgICovXG4gIF9hY3Rpb25NQUlMIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ01BSUwgRlJPTSB1bnN1Y2Nlc3NmdWw6ICcgKyBjb21tYW5kLmRhdGEpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUubGVuZ3RoKSB7XG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignQ2FuXFwndCBzZW5kIG1haWwgLSBubyByZWNpcGllbnRzIGRlZmluZWQnKSlcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnTUFJTCBGUk9NIHN1Y2Nlc3NmdWwsIHByb2NlZWRpbmcgd2l0aCAnICsgdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLmxlbmd0aCArICcgcmVjaXBpZW50cycpXG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBZGRpbmcgcmVjaXBpZW50Li4uJylcbiAgICAgIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCA9IHRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5zaGlmdCgpXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uUkNQVFxuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ1JDUFQgVE86PCcgKyB0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQgKyAnPicpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIGEgUkNQVCBUTyBjb21tYW5kLiBJZiB0aGUgY29tbWFuZCBpcyB1bnN1Y2Nlc3NmdWwsIHRyeSB0aGUgbmV4dCBvbmUsXG4gICAqIGFzIHRoaXMgbWlnaHQgYmUgcmVsYXRlZCBvbmx5IHRvIHRoZSBjdXJyZW50IHJlY2lwaWVudCwgbm90IGEgZ2xvYmFsIGVycm9yLCBzb1xuICAgKiB0aGUgZm9sbG93aW5nIHJlY2lwaWVudHMgbWlnaHQgc3RpbGwgYmUgdmFsaWRcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICAgKi9cbiAgX2FjdGlvblJDUFQgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIud2FybihERUJVR19UQUcsICdSQ1BUIFRPIGZhaWxlZCBmb3I6ICcgKyB0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQpXG4gICAgICAvLyB0aGlzIGlzIGEgc29mdCBlcnJvclxuICAgICAgdGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZC5wdXNoKHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudClcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZS5wdXNoKHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudClcbiAgICB9XG5cbiAgICBpZiAoIXRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5sZW5ndGgpIHtcbiAgICAgIGlmICh0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkLmxlbmd0aCA8IHRoaXMuX2VudmVsb3BlLnRvLmxlbmd0aCkge1xuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uREFUQVxuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdSQ1BUIFRPIGRvbmUsIHByb2NlZWRpbmcgd2l0aCBwYXlsb2FkJylcbiAgICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0RBVEEnKVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0NhblxcJ3Qgc2VuZCBtYWlsIC0gYWxsIHJlY2lwaWVudHMgd2VyZSByZWplY3RlZCcpKVxuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBZGRpbmcgcmVjaXBpZW50Li4uJylcbiAgICAgIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCA9IHRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5zaGlmdCgpXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uUkNQVFxuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ1JDUFQgVE86PCcgKyB0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQgKyAnPicpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIHRoZSBSU0VUIGNvbW1hbmQuIElmIHN1Y2Nlc3NmdWwsIGNsZWFyIHRoZSBjdXJyZW50IGF1dGhlbnRpY2F0aW9uXG4gICAqIGluZm9ybWF0aW9uIGFuZCByZWF1dGhlbnRpY2F0ZS5cbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICAgKi9cbiAgX2FjdGlvblJTRVQgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnUlNFVCB1bnN1Y2Nlc3NmdWwgJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLl9hdXRoZW50aWNhdGVkQXMgPSBudWxsXG4gICAgdGhpcy5fYXV0aGVudGljYXRlVXNlcigpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gdGhlIERBVEEgY29tbWFuZC4gU2VydmVyIGlzIG5vdyB3YWl0aW5nIGZvciBhIG1lc3NhZ2UsIHNvIGVtaXQgYG9ucmVhZHlgXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAgICovXG4gIF9hY3Rpb25EQVRBIChjb21tYW5kKSB7XG4gICAgLy8gcmVzcG9uc2Ugc2hvdWxkIGJlIDM1NCBidXQgYWNjb3JkaW5nIHRvIHRoaXMgaXNzdWUgaHR0cHM6Ly9naXRodWIuY29tL2VsZWl0aC9lbWFpbGpzL2lzc3Vlcy8yNFxuICAgIC8vIHNvbWUgc2VydmVycyBtaWdodCB1c2UgMjUwIGluc3RlYWRcbiAgICBpZiAoWzI1MCwgMzU0XS5pbmRleE9mKGNvbW1hbmQuc3RhdHVzQ29kZSkgPCAwKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdEQVRBIHVuc3VjY2Vzc2Z1bCAnICsgY29tbWFuZC5kYXRhKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMuX2RhdGFNb2RlID0gdHJ1ZVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgdGhpcy5vbnJlYWR5KHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgZnJvbSB0aGUgc2VydmVyLCBvbmNlIHRoZSBtZXNzYWdlIHN0cmVhbSBoYXMgZW5kZWQgd2l0aCA8Q1I+PExGPi48Q1I+PExGPlxuICAgKiBFbWl0cyBgb25kb25lYC5cbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICAgKi9cbiAgX2FjdGlvblN0cmVhbSAoY29tbWFuZCkge1xuICAgIHZhciByY3B0XG5cbiAgICBpZiAodGhpcy5vcHRpb25zLmxtdHApIHtcbiAgICAgIC8vIExNVFAgcmV0dXJucyBhIHJlc3BvbnNlIGNvZGUgZm9yICpldmVyeSogc3VjY2Vzc2Z1bGx5IHNldCByZWNpcGllbnRcbiAgICAgIC8vIEZvciBldmVyeSByZWNpcGllbnQgdGhlIG1lc3NhZ2UgbWlnaHQgc3VjY2VlZCBvciBmYWlsIGluZGl2aWR1YWxseVxuXG4gICAgICByY3B0ID0gdGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZS5zaGlmdCgpXG4gICAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdMb2NhbCBkZWxpdmVyeSB0byAnICsgcmNwdCArICcgZmFpbGVkLicpXG4gICAgICAgIHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQucHVzaChyY3B0KVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnTG9jYWwgZGVsaXZlcnkgdG8gJyArIHJjcHQgKyAnIHN1Y2NlZWRlZC4nKVxuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvblN0cmVhbVxuICAgICAgICByZXR1cm5cbiAgICAgIH1cblxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICAgIHRoaXMub25kb25lKHRydWUpXG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEZvciBTTVRQIHRoZSBtZXNzYWdlIGVpdGhlciBmYWlscyBvciBzdWNjZWVkcywgdGhlcmUgaXMgbm8gaW5mb3JtYXRpb25cbiAgICAgIC8vIGFib3V0IGluZGl2aWR1YWwgcmVjaXBpZW50c1xuXG4gICAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdNZXNzYWdlIHNlbmRpbmcgZmFpbGVkLicpXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdNZXNzYWdlIHNlbnQgc3VjY2Vzc2Z1bGx5LicpXG4gICAgICB9XG5cbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgICB0aGlzLm9uZG9uZSghIWNvbW1hbmQuc3VjY2VzcywgY29tbWFuZClcbiAgICB9XG5cbiAgICAvLyBJZiB0aGUgY2xpZW50IHdhbnRlZCB0byBkbyBzb21ldGhpbmcgZWxzZSAoZWcuIHRvIHF1aXQpLCBkbyBub3QgZm9yY2UgaWRsZVxuICAgIGlmICh0aGlzLl9jdXJyZW50QWN0aW9uID09PSB0aGlzLl9hY3Rpb25JZGxlKSB7XG4gICAgICAvLyBXYWl0aW5nIGZvciBuZXcgY29ubmVjdGlvbnNcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0lkbGluZyB3aGlsZSB3YWl0aW5nIGZvciBuZXcgY29ubmVjdGlvbnMuLi4nKVxuICAgICAgdGhpcy5vbmlkbGUoKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBCdWlsZHMgYSBsb2dpbiB0b2tlbiBmb3IgWE9BVVRIMiBhdXRoZW50aWNhdGlvbiBjb21tYW5kXG4gICAqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSB1c2VyIEUtbWFpbCBhZGRyZXNzIG9mIHRoZSB1c2VyXG4gICAqIEBwYXJhbSB7U3RyaW5nfSB0b2tlbiBWYWxpZCBhY2Nlc3MgdG9rZW4gZm9yIHRoZSB1c2VyXG4gICAqIEByZXR1cm4ge1N0cmluZ30gQmFzZTY0IGZvcm1hdHRlZCBsb2dpbiB0b2tlblxuICAgKi9cbiAgX2J1aWxkWE9BdXRoMlRva2VuICh1c2VyLCB0b2tlbikge1xuICAgIHZhciBhdXRoRGF0YSA9IFtcbiAgICAgICd1c2VyPScgKyAodXNlciB8fCAnJyksXG4gICAgICAnYXV0aD1CZWFyZXIgJyArIHRva2VuLFxuICAgICAgJycsXG4gICAgICAnJ1xuICAgIF1cbiAgICAvLyBiYXNlNjQoXCJ1c2VyPXtVc2VyfVxceDAwYXV0aD1CZWFyZXIge1Rva2VufVxceDAwXFx4MDBcIilcbiAgICByZXR1cm4gZW5jb2RlKGF1dGhEYXRhLmpvaW4oJ1xceDAxJykpXG4gIH1cblxuICBjcmVhdGVMb2dnZXIgKGNyZWF0b3IgPSBjcmVhdGVEZWZhdWx0TG9nZ2VyKSB7XG4gICAgY29uc3QgbG9nZ2VyID0gY3JlYXRvcigodGhpcy5vcHRpb25zLmF1dGggfHwge30pLnVzZXIgfHwgJycsIHRoaXMuaG9zdClcbiAgICB0aGlzLmxvZ0xldmVsID0gdGhpcy5MT0dfTEVWRUxfQUxMXG4gICAgdGhpcy5sb2dnZXIgPSB7XG4gICAgICBkZWJ1ZzogKC4uLm1zZ3MpID0+IHsgaWYgKExPR19MRVZFTF9ERUJVRyA+PSB0aGlzLmxvZ0xldmVsKSB7IGxvZ2dlci5kZWJ1Zyhtc2dzKSB9IH0sXG4gICAgICBpbmZvOiAoLi4ubXNncykgPT4geyBpZiAoTE9HX0xFVkVMX0lORk8gPj0gdGhpcy5sb2dMZXZlbCkgeyBsb2dnZXIuaW5mbyhtc2dzKSB9IH0sXG4gICAgICB3YXJuOiAoLi4ubXNncykgPT4geyBpZiAoTE9HX0xFVkVMX1dBUk4gPj0gdGhpcy5sb2dMZXZlbCkgeyBsb2dnZXIud2Fybihtc2dzKSB9IH0sXG4gICAgICBlcnJvcjogKC4uLm1zZ3MpID0+IHsgaWYgKExPR19MRVZFTF9FUlJPUiA+PSB0aGlzLmxvZ0xldmVsKSB7IGxvZ2dlci5lcnJvcihtc2dzKSB9IH1cbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgU210cENsaWVudFxuIl19