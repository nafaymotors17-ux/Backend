const Redis = require("ioredis");

const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

// Store cache with TTL (default 5 minutes)
const setCache = async (key, value, ttl = 300) => {
  console.log("Done");
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttl);
  } catch (err) {
    console.error("❌ Redis setCache error:", err);
  }
};

const getCache = async (key) => {
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    console.error("❌ Redis getCache error:", err);
    return null;
  }
};

// Delete a specific key or prefix (for admin invalidation)
const delCacheByPrefix = async (prefix) => {
  try {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(keys);
  } catch (err) {
    console.error("❌ Redis delCacheByPrefix error:", err);
  }
};

module.exports = { setCache, getCache, delCacheByPrefix };
