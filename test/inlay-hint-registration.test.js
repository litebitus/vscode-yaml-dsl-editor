const test = require('node:test');
const assert = require('node:assert/strict');
const { createInlayHintRegistration } = require('../lib/inlay-hint-registration');

const devUri = 'file:///repo/dev/mock.yml';
const stagingUri = 'file:///repo/staging/mock.yml';
const selector = { language: 'mock-language' };

function mockDocument(uri) {
  return { uri: { toString: () => uri } };
}

function editorHost() {
  const host = { registrations: [], fires: 0 };
  host.vscode = {
    EventEmitter: class {
      constructor() {
        this.disposed = false;
        this.event = () => ({ dispose() {} });
      }

      fire() { host.fires += 1; }

      dispose() { this.disposed = true; }
    },
    languages: {
      registerInlayHintsProvider(registeredSelector, provider) {
        const registration = { selector: registeredSelector, provider, disposed: false };
        host.registrations.push(registration);
        return { dispose() { registration.disposed = true; } };
      },
    },
  };
  host.live = () => host.registrations.filter((registration) => !registration.disposed);
  return host;
}

function hintsFrom(hintsByUri) {
  return (document) => hintsByUri.get(document.uri.toString()) || [];
}

test('registers one provider for the selector', () => {
  const host = editorHost();
  createInlayHintRegistration(host.vscode, selector, hintsFrom(new Map()));
  assert.equal(host.live().length, 1);
  assert.deepEqual(host.live()[0].selector, selector);
});

test('answers the hints of the document asked for', () => {
  const host = editorHost();
  const hintsByUri = new Map([[devUri, ['mock-hint']]]);
  createInlayHintRegistration(host.vscode, selector, hintsFrom(hintsByUri));
  assert.deepEqual(host.live()[0].provider.provideInlayHints(mockDocument(devUri)), ['mock-hint']);
});

test('fires the change event when no file answered empty', () => {
  const host = editorHost();
  const hintsByUri = new Map([[devUri, ['mock-hint']]]);
  const registration = createInlayHintRegistration(host.vscode, selector, hintsFrom(hintsByUri));
  host.live()[0].provider.provideInlayHints(mockDocument(devUri));
  registration.refreshHints(() => true);
  assert.equal(host.fires, 1);
  assert.equal(host.registrations.length, 1);
});

test('registers again when a file that answered empty now has hints', () => {
  const host = editorHost();
  const hintsByUri = new Map();
  const registration = createInlayHintRegistration(host.vscode, selector, hintsFrom(hintsByUri));
  host.live()[0].provider.provideInlayHints(mockDocument(devUri));
  hintsByUri.set(devUri, ['mock-hint']);
  registration.refreshHints((uri) => hintsByUri.has(uri));
  assert.equal(host.fires, 0);
  assert.equal(host.registrations.length, 2);
  assert.equal(host.registrations[0].disposed, true);
  assert.equal(host.live().length, 1);
  assert.deepEqual(host.live()[0].provider.provideInlayHints(mockDocument(devUri)), ['mock-hint']);
});

test('fires the change event while a file that answered empty still has no hints', () => {
  const host = editorHost();
  const hintsByUri = new Map([[stagingUri, ['mock-hint']]]);
  const registration = createInlayHintRegistration(host.vscode, selector, hintsFrom(hintsByUri));
  host.live()[0].provider.provideInlayHints(mockDocument(devUri));
  registration.refreshHints((uri) => hintsByUri.has(uri));
  assert.equal(host.fires, 1);
  assert.equal(host.registrations.length, 1);
});

test('a file answered with hints after an empty answer no longer registers again', () => {
  const host = editorHost();
  const hintsByUri = new Map();
  const registration = createInlayHintRegistration(host.vscode, selector, hintsFrom(hintsByUri));
  host.live()[0].provider.provideInlayHints(mockDocument(devUri));
  hintsByUri.set(devUri, ['mock-hint']);
  registration.refreshHints((uri) => hintsByUri.has(uri));
  host.live()[0].provider.provideInlayHints(mockDocument(devUri));
  registration.refreshHints((uri) => hintsByUri.has(uri));
  assert.equal(host.registrations.length, 2);
  assert.equal(host.fires, 1);
});

test('a forgotten file no longer registers again', () => {
  const host = editorHost();
  const hintsByUri = new Map();
  const registration = createInlayHintRegistration(host.vscode, selector, hintsFrom(hintsByUri));
  host.live()[0].provider.provideInlayHints(mockDocument(devUri));
  registration.forgetUri(devUri);
  hintsByUri.set(devUri, ['mock-hint']);
  registration.refreshHints((uri) => hintsByUri.has(uri));
  assert.equal(host.registrations.length, 1);
  assert.equal(host.fires, 1);
});

test('dispose removes the provider', () => {
  const host = editorHost();
  const registration = createInlayHintRegistration(host.vscode, selector, hintsFrom(new Map()));
  registration.dispose();
  assert.equal(host.live().length, 0);
});
