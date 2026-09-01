import Database from 'better-sqlite3';

describe('better-sqlite3 native binding', () => {
  test('loads and executes a query', () => {
    const database = new Database(':memory:');

    expect(database.prepare('SELECT 24 AS node_major').get()).toEqual({ node_major: 24 });

    database.close();
  });
});
