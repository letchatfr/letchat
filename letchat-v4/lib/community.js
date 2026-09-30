// Visible activity only: distinct accounts, no discreet profiles or blocked pairs.
export function installCommunity({ app, pool, auth, requireAdult, requireRules, online, isDiscreet, rooms }) {
  const roomIds = ["cafe", "actualites", "debats", "creatifs", "amateurs", "webcam"];
  app.get("/api/community/home", auth, requireAdult, requireRules, async (req, res, next) => {
    try {
      const blocked = new Set((await pool.query(`SELECT CASE WHEN blocker_id=$1 THEN blocked_id ELSE blocker_id END AS id
        FROM letchat_blocks WHERE blocker_id=$1 OR blocked_id=$1`, [req.user.id])).rows.map(row => row.id));
      const members = new Map(), counts = new Map(roomIds.map(id => [id, new Set()]));
      for (const { user, room } of online.values()) {
        if (user.id === req.user.id || blocked.has(user.id) || isDiscreet(user.id) || Date.now() >= user.expiresAt) continue;
        members.set(user.id, user);
        counts.get(room)?.add(user.id);
      }
      const available = [...members.values()].filter(user =>
        (user.profile?.availability || "available") === "available" &&
        (user.profile?.private_message_policy || "everyone") === "everyone"
      ).map(user => ({ id:user.id, name:user.name || "Membre", photo:user.photo || "" }));
      res.set("Cache-Control", "no-store").json({
        onlineCount:members.size, availableCount:available.length, members:available.slice(0, 8),
        rooms:roomIds.map(id => ({ id, title:rooms[id].title, description:rooms[id].welcome, count:counts.get(id).size }))
          .sort((a,b) => b.count - a.count),
        updatedAt:new Date().toISOString(),
      });
    } catch (error) { next(error); }
  });
}
