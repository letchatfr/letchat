import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrateNotificationPreferences } from '../lib/message-tools.js';

for (const legacy of [false, true]) {
  test(`notification preferences migrate ${legacy ? 'the production legacy schema' : 'a new database'} without losing choices`, async t => {
    const db = await PGlite.create();
    t.after(() => db.close());
    await db.exec("CREATE TABLE profiles(user_id TEXT PRIMARY KEY); INSERT INTO profiles VALUES('existing'),('new');");
    if (legacy) await db.exec(`CREATE TABLE letchat_notification_preferences (
      user_id TEXT PRIMARY KEY REFERENCES profiles(user_id),
      private_messages BOOLEAN NOT NULL DEFAULT TRUE,
      friends BOOLEAN NOT NULL DEFAULT TRUE, reports BOOLEAN NOT NULL DEFAULT TRUE
    ); INSERT INTO letchat_notification_preferences VALUES ('existing',FALSE,FALSE,FALSE);`);
    const pool = { query: sql => db.exec(sql) };
    await migrateNotificationPreferences(pool);
    if (legacy) {
      const row = (await db.query("SELECT * FROM letchat_notification_preferences WHERE user_id='existing'")).rows[0];
      assert.equal(row.private_messages, false);
      assert.equal(row.friendships, false);
      assert.equal(row.reports, false);
      assert.equal(row.preview, true);
      assert.equal(row.quiet_until, null);
    }
    await db.exec("INSERT INTO letchat_notification_preferences(user_id) VALUES('new');");
    const defaults = (await db.query("SELECT private_messages,friendships,preview,quiet_until FROM letchat_notification_preferences WHERE user_id='new'")).rows[0];
    assert.deepEqual(defaults, { private_messages: true, friendships: true, preview: true, quiet_until: null });
    await db.exec("UPDATE letchat_notification_preferences SET friendships=FALSE,preview=FALSE,quiet_until=NOW()+INTERVAL '8 hours' WHERE user_id='new';");
    if (legacy) await db.exec("UPDATE letchat_notification_preferences SET friendships=TRUE WHERE user_id='existing';");
    const before = (await db.query('SELECT * FROM letchat_notification_preferences ORDER BY user_id')).rows;
    await migrateNotificationPreferences(pool);
    assert.deepEqual((await db.query('SELECT * FROM letchat_notification_preferences ORDER BY user_id')).rows, before);
  });
}

