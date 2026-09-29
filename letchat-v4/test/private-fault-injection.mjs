// Loaded only by the isolated private-recipient test server, never by npm start.
import pg from "pg";
if (process.env.NODE_ENV !== "test") throw new Error("Test-only notification fault injector");
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (sql, values, ...rest) {
  if (typeof sql === "string" && sql.includes("INSERT INTO letchat_notifications") &&
      values?.[3] === "atomic-failure-probe") {
    return Promise.reject(Object.assign(new Error("Isolated notification failure"), { code: "TEST_NOTIFICATION_FAILURE" }));
  }
  return query.call(this, sql, values, ...rest);
};
