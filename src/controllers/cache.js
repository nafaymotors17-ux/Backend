// src/utils/cache.js
const NodeCache = require("node-cache");
const cache = new NodeCache({ stdTTL: 180, checkperiod: 60 }); // cache 5 min

// simple helpers
exports.get = (key) => cache.get(key);
exports.set = (key, value, ttl = 300) => cache.set(key, value, ttl);
exports.del = (key) => cache.del(key);
exports.flush = () => cache.flushAll();

exports.keys = () => cache.keys();

exports.delByPrefix = (prefix) => {
  const allKeys = exports.keys(); // use exports.keys() here
  const toDelete = allKeys.filter((key) => key.startsWith(prefix));
  if (toDelete.length > 0) {
    cache.del(toDelete);
    console.log(`🧹 Cleared ${toDelete.length} keys with prefix "${prefix}"`);
  }
};

// Helper: clear all shipment-related caches
exports.clearShipmentCache = () => {
  const allKeys = exports.keys(); // ✅ use exports.keys()
  const shipmentKeys = allKeys.filter((k) => k.startsWith("shipments_"));
  for (const k of shipmentKeys) {
    exports.del(k); // ✅ use exports.del()
    console.log(`🧹 Cleared cache: ${k}`);
  }
};

exports.clearUserCache = () => {
  const allKeys = exports.keys();
  const userKeys = allKeys.filter((k) => k.startsWith("users_"));
  for (const k of userKeys) {
    exports.del(k);
    console.log(`🧹 Cleared cache: ${k}`);
  }
};
