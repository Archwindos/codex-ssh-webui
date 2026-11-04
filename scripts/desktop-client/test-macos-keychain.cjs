const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'macos-keychain.js'), 'utf8');
const password = 'TEST_ONLY_中文 🔑 $`"\\ & /';

function fixture() {
  let stored = null, input = '', output = '';
  const failures = {};
  const object = value => ({ objc: true, value });
  const ref = value => ({ cfRef: true, object: value });
  const string = value => ({ ...object(String(value)), dataUsingEncoding: () => object({ data: String(value) }) });
  const unwrap = value => {
    assert.equal(value?.objc, true, 'Foundation requires an Objective-C object, not a CF Ref');
    return value.value;
  };
  const dollar = value => string(value);
  const dictionary = () => ({ values: {}, setObjectForKey(value, key) {
    this.values[unwrap(key)] = unwrap(value);
  } });
  const checkQuery = query => {
    assert.equal(query.values.class, 'generic');
    assert.equal(query.values.service, 'com.codex-ssh-webui.desktop-client');
    assert.equal(query.values.account, 'connection-v1');
  };
  const failed = operation => {
    if (failures[operation] instanceof Error) throw failures[operation];
    return failures[operation] || 0;
  };
  Object.assign(dollar, {
    NSMutableDictionary: { alloc: { get init() { return dictionary(); } } },
    NSString: { alloc: { initWithDataEncoding: data => string(unwrap(data).data) } },
    NSUTF8StringEncoding: 4,
    NSFileHandle: {
      fileHandleWithStandardInput: { get readDataToEndOfFile() { return object({ data: input }); } },
      fileHandleWithStandardOutput: { writeData: data => { output += unwrap(data).data; } }
    },
    SecItemCopyMatching(query, result) {
      checkQuery(query);
      assert.equal(query.values.returnData, true); assert.equal(query.values.limit, 'one');
      if (failed('read')) return failed('read');
      if (stored === null) return -25300;
      result[0] = ref(object({ data: stored }));
      return 0;
    },
    SecItemUpdate(query, attributes) {
      checkQuery(query);
      if (failed('update')) return failed('update');
      if (stored === null) return -25300;
      stored = attributes.values.data.data;
      return 0;
    },
    SecItemAdd(query) {
      checkQuery(query);
      assert.equal(query.values.sync, false);
      assert.equal(query.values.label, 'Codex SSH WebUI connection');
      if (failed('add')) return failed('add');
      stored = query.values.data.data;
      return 0;
    },
    SecItemDelete(query) {
      checkQuery(query);
      if (failed('delete')) return failed('delete');
      if (stored === null) return -25300;
      stored = null;
      return 0;
    }
  });
  const constants = {
    kSecClass: 'class', kSecClassGenericPassword: 'generic', kSecAttrService: 'service', kSecAttrAccount: 'account',
    kSecReturnData: 'returnData', kSecMatchLimit: 'limit', kSecMatchLimitOne: 'one', kCFBooleanTrue: true,
    kCFBooleanFalse: false, kSecValueData: 'data', kSecAttrLabel: 'label', kSecAttrSynchronizable: 'sync'
  };
  for (const [key, value] of Object.entries(constants)) dollar[key] = ref(object(value));
  const context = vm.createContext({ $: dollar, ObjC: {
    import() {}, unwrap,
    castRefToObject(value) { assert.equal(value?.cfRef, true, 'Only CF references may be cast'); return value.object; }
  }, Ref: () => [] });
  vm.runInContext(source, context);
  return {
    run: args => context.run(args), failures,
    save(value = password) { input = ['test.invalid', '22', 'test-user', '8443', '8443', value, ''].join('\n'); return context.run(['save']); },
    get stored() { return stored; }, set stored(value) { stored = value; },
    get output() { return output; }, clearOutput() { output = ''; }
  };
}

test('CF references cross the Foundation boundary for create, read, update and delete', () => {
  const f = fixture();
  assert.equal(f.run(['metadata']), 'MISSING');
  assert.equal(f.save(), 'STORED');
  assert.equal(JSON.parse(f.stored).password, password);
  assert.equal(f.run(['metadata']), 'READY\ntest.invalid\n22\ntest-user\n8443\n8443');
  assert.equal(f.save(password + ' updated'), 'STORED');
  f.run(['password', "test-user@key-name.example's password: ", 'key-name.example']);
  assert.equal(f.output, password + ' updated\n');
  assert.equal(f.run(['forget']), 'DELETED');
  assert.equal(f.stored, null);
  assert.equal(f.run(['forget']), 'DELETED');
  assert.equal(f.run(['metadata']), 'MISSING');
});

test('metadata and rejected SSH prompts never emit passwords', () => {
  const f = fixture(); f.save();
  assert.ok(!f.run(['metadata']).includes(password));
  for (const prompt of ['Enter passphrase for key: ', 'Verification code: ', "other@test.invalid's password: ", "test-user@other.invalid's password: "]) {
    assert.throws(() => f.run(['password', prompt, 'test.invalid']), /Secure connection operation failed/);
    assert.equal(f.output, '');
  }
});

test('parameter failures retain the OSStatus from every Keychain operation without suggesting unlock', () => {
  for (const operation of ['read', 'update', 'add', 'delete']) {
    const f = fixture();
    if (operation !== 'add') f.save();
    f.failures[operation] = -50;
    const action = operation === 'read' ? () => f.run(['metadata']) : operation === 'delete' ? () => f.run(['forget']) : () => f.save();
    assert.throws(action, error => /OSStatus -50/.test(error.message) && /parameter/i.test(error.message) && !/unlock/i.test(error.message) && !error.message.includes(password));
    assert.equal(f.output, '');
  }
});

test('permission errors have specific advice; cancellation and unknown statuses retain only safe numeric diagnostics', () => {
  const f = fixture(); f.save();
  for (const code of [-25293, -25308, -128, -25291, -99999]) {
    f.failures.read = code;
    assert.throws(() => f.run(['metadata']), error => {
      assert.ok(error.message.includes('OSStatus ' + code));
      assert.equal(/unlock|allow access/i.test(error.message), code === -25293 || code === -25308);
      for (const secret of [password, 'test.invalid', 'test-user']) assert.ok(!error.message.includes(secret));
      return true;
    });
  }
});

test('corrupt saved data and native exceptions never disclose configuration or raw exception text', () => {
  const f = fixture(); f.save(); const saved = f.stored;
  for (const patch of [{ host: 'host;bad' }, { user: 'root;bad' }, { sshPort: '' }, { localPort: '80' }, { remotePort: '65536' }, { password: 'bad\nline' }, { extra: 'not allowed' }]) {
    f.stored = JSON.stringify({ ...JSON.parse(saved), ...patch });
    assert.throws(() => f.run(['metadata']), error => /Secure connection operation failed/.test(error.message) && !error.message.includes(password) && !/unlock/i.test(error.message));
  }
  f.stored = saved;
  f.failures.read = new Error(saved);
  assert.throws(() => f.run(['metadata']), error => !error.message.includes(password) && !error.message.includes('test.invalid') && !error.message.includes(saved));
  assert.equal(f.output, '');
});
