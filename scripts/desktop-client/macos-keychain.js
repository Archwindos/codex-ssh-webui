/* macOS JXA only. Passwords enter over stdin and leave only for SSH askpass. */
ObjC.import('Foundation');
ObjC.import('Security');

var service = 'com.codex-ssh-webui.desktop-client';
var account = 'connection-v1';

function cfObject(value) {
  return ObjC.castRefToObject(value);
}

function baseQuery() {
  var query = $.NSMutableDictionary.alloc.init;
  query.setObjectForKey(cfObject($.kSecClassGenericPassword), cfObject($.kSecClass));
  query.setObjectForKey($(service), cfObject($.kSecAttrService));
  query.setObjectForKey($(account), cfObject($.kSecAttrAccount));
  return query;
}

function checkStatus(status) {
  var code = Number(status);
  if (code !== 0) {
    var error = new Error('Keychain operation failed.');
    if (isFinite(code) && Math.floor(code) === code) error.osStatus = code;
    throw error;
  }
}

function validate(record) {
  if (!record || Object.prototype.toString.call(record) !== '[object Object]' ||
      Object.keys(record).sort().join(',') !== 'host,localPort,password,remotePort,sshPort,user') throw new Error('Invalid saved connection.');
  if (typeof record.host !== 'string' || record.host.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.host) ||
      typeof record.user !== 'string' || record.user.length > 64 || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(record.user)) throw new Error('Invalid SSH address or username.');
  ['sshPort', 'localPort', 'remotePort'].forEach(function (name) {
    var value = record[name];
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535 ||
        Number(value) < (name === 'localPort' ? 1024 : 1)) throw new Error('Invalid connection port.');
  });
  if (typeof record.password !== 'string' || !record.password.length || /[\x00-\x1f\x7f]/.test(record.password)) throw new Error('A nonempty single-line SSH password is required.');
  return record;
}

function readConnection() {
  var query = baseQuery();
  query.setObjectForKey(cfObject($.kCFBooleanTrue), cfObject($.kSecReturnData));
  query.setObjectForKey(cfObject($.kSecMatchLimitOne), cfObject($.kSecMatchLimit));
  var result = Ref();
  var status = Number($.SecItemCopyMatching(query, result));
  if (status === -25300) return null; // errSecItemNotFound
  checkStatus(status);
  var encoded = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(cfObject(result[0]), $.NSUTF8StringEncoding));
  return validate(JSON.parse(encoded));
}

function saveConnection() {
  var input = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(
    $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding));
  var fields = input.split('\n');
  if (fields.length !== 7 || fields[6] !== '') throw new Error('Invalid connection input.');
  var record = validate({ host: fields[0], sshPort: fields[1], user: fields[2],
    localPort: fields[3], remotePort: fields[4], password: fields[5] });
  var data = $(JSON.stringify(record)).dataUsingEncoding($.NSUTF8StringEncoding);
  var attributes = $.NSMutableDictionary.alloc.init;
  attributes.setObjectForKey(data, cfObject($.kSecValueData));
  var status = Number($.SecItemUpdate(baseQuery(), attributes));
  if (status === -25300) {
    var query = baseQuery();
    query.setObjectForKey(data, cfObject($.kSecValueData));
    query.setObjectForKey($('Codex SSH WebUI connection'), cfObject($.kSecAttrLabel));
    // Use the local login Keychain; do not enable iCloud synchronization.
    query.setObjectForKey(cfObject($.kCFBooleanFalse), cfObject($.kSecAttrSynchronizable));
    status = Number($.SecItemAdd(query, Ref()));
  }
  checkStatus(status);
}

function run(argv) {
  try {
    if (argv.length === 1 && argv[0] === 'save') {
      saveConnection();
      return 'STORED';
    }
    if (argv.length === 1 && argv[0] === 'metadata') {
      var connection = readConnection();
      if (!connection) return 'MISSING';
      return ['READY', connection.host, connection.sshPort, connection.user,
        connection.localPort, connection.remotePort].join('\n');
    }
    if (argv.length === 1 && argv[0] === 'forget') {
      var deletionStatus = Number($.SecItemDelete(baseQuery()));
      if (deletionStatus !== -25300) checkStatus(deletionStatus);
      return 'DELETED';
    }
    if (argv.length === 3 && argv[0] === 'password') {
      var saved = readConnection();
      if (!saved) throw new Error('No saved connection.');
      var effectiveHost = argv[2];
      if (!/^[A-Za-z0-9:][A-Za-z0-9._:%-]*$/.test(effectiveHost)) throw new Error('Invalid effective hostname.');
      var expected = saved.user + '@' + effectiveHost + "'s password:";
      if (argv[1] !== expected && argv[1] !== expected + ' ') throw new Error('Unsupported SSH prompt.');
      // Write exact bytes, avoiding osascript's human-readable result formatting.
      $.NSFileHandle.fileHandleWithStandardOutput.writeData($(saved.password + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
      return;
    }
    throw new Error('Unsupported Keychain operation.');
  } catch (error) {
    // Never include input, saved data, prompts or native exception objects.
    if (error && typeof error.osStatus === 'number' && isFinite(error.osStatus) && Math.floor(error.osStatus) === error.osStatus) {
      var message = 'Secure connection operation failed (OSStatus ' + error.osStatus + ').';
      if (error.osStatus === -50) message += ' Invalid Keychain parameters; the client needs correction.';
      else if (error.osStatus === -25293 || error.osStatus === -25308) message += ' Keychain access was denied. Unlock Keychain or allow access, then retry.';
      else if (error.osStatus === -128) message += ' Keychain access was cancelled.';
      throw new Error(message);
    }
    throw new Error('Secure connection operation failed. Check the connection settings or run --configure again.');
  }
}
