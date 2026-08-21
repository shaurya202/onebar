// A minimal in-memory IndexedDB for tools/boot_check.mjs.
//
// The frontend keeps three things in IndexedDB — the hazard cache, the offline mutation
// queue, and the in-progress trip — plus the region packs. All of that is invisible to a
// harness that simply makes `indexedDB.open()` throw, which is the state the code
// degrades to when storage is denied. That is worth testing, but it is not the path
// most users are on, and the paths that matter most offline are exactly the ones it
// hides.
//
// This implements only what those modules use: open with an upgrade callback,
// readwrite/readonly transactions, and put/get/getAll/delete/add on a keyPath store.

class FakeRequest {
  constructor() {
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
    this.onblocked = null;
    this.result = undefined;
  }

  succeed(result) {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.({ target: this }));
  }
}

class FakeObjectStore {
  constructor(name, keyPath, autoIncrement, rows, tx) {
    this.name = name;
    this.keyPath = keyPath;
    this.autoIncrement = autoIncrement;
    this._rows = rows;
    this._tx = tx;
  }

  _key(value) {
    return this.keyPath ? value[this.keyPath] : undefined;
  }

  put(value) {
    const request = new FakeRequest();
    this._tx._enqueue(() => {
      const key = this._key(value);
      this._rows.set(key, structuredClone(value));
      request.succeed(key);
    });
    return request;
  }

  add(value) {
    const request = new FakeRequest();
    this._tx._enqueue(() => {
      const record = { ...value };
      if (this.autoIncrement && record[this.keyPath] === undefined) {
        record[this.keyPath] = this._rows.size + 1;
      }
      const key = this._key(record);
      this._rows.set(key, structuredClone(record));
      request.succeed(key);
    });
    return request;
  }

  get(key) {
    const request = new FakeRequest();
    this._tx._enqueue(() => request.succeed(
      this._rows.has(key) ? structuredClone(this._rows.get(key)) : undefined,
    ));
    return request;
  }

  getAll() {
    const request = new FakeRequest();
    this._tx._enqueue(() => request.succeed(
      Array.from(this._rows.values(), (row) => structuredClone(row)),
    ));
    return request;
  }

  delete(key) {
    const request = new FakeRequest();
    this._tx._enqueue(() => {
      this._rows.delete(key);
      request.succeed(undefined);
    });
    return request;
  }
}

class FakeTransaction {
  constructor(db, names) {
    this._db = db;
    this._names = names;
    this._queue = [];
    this._drainScheduled = false;
    this.oncomplete = null;
    this.onerror = null;
    this._schedule();
  }

  _enqueue(task) {
    this._queue.push(task);
    this._schedule();
  }

  _schedule() {
    if (this._drainScheduled) return;
    this._drainScheduled = true;
    // Two microtask hops: enough for a handler set inside an onsuccess callback to
    // enqueue further work before the transaction reports completion, which is how
    // replaceLocalHazards drives its deletes.
    queueMicrotask(() => queueMicrotask(() => {
      this._drainScheduled = false;
      const batch = this._queue.splice(0);
      for (const task of batch) task();
      queueMicrotask(() => queueMicrotask(() => {
        if (this._queue.length) {
          this._schedule();
          return;
        }
        this.oncomplete?.({ target: this });
      }));
    }));
  }

  objectStore(name) {
    const meta = this._db._stores.get(name);
    if (!meta) throw new Error(`No object store named ${name}`);
    return new FakeObjectStore(name, meta.keyPath, meta.autoIncrement, meta.rows, this);
  }
}

class FakeDatabase {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this._stores = new Map();
    this.objectStoreNames = {
      contains: (name) => this._stores.has(name),
    };
  }

  createObjectStore(name, { keyPath = null, autoIncrement = false } = {}) {
    this._stores.set(name, { keyPath, autoIncrement, rows: new Map() });
    return { name };
  }

  transaction(names) {
    return new FakeTransaction(this, Array.isArray(names) ? names : [names]);
  }
}

const databases = new Map();

export function createFakeIndexedDB() {
  return {
    open(name, version = 1) {
      const request = new FakeRequest();
      queueMicrotask(() => {
        let db = databases.get(name);
        const isNew = !db || db.version < version;
        if (!db) {
          db = new FakeDatabase(name, version);
          databases.set(name, db);
        }
        if (isNew) {
          db.version = version;
          request.result = db;
          request.onupgradeneeded?.({ target: request, oldVersion: 0, newVersion: version });
        }
        request.succeed(db);
      });
      return request;
    },
  };
}

export function resetFakeIndexedDB() {
  databases.clear();
}
