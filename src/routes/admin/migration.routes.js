const express = require("express");
const router = express.Router();
const migrationController = require("../../controllers/migration.controller");
const jwtMiddleware = require("../../middlewares/jwt.middleware");
const asyncHandler = require("../../utils/asyncHandler");

// Migration routes - protected by JWT
router.get(
  "/analyze",
  jwtMiddleware,
  asyncHandler(migrationController.analyzeMigration)
);
router.post(
  "/execute",
  jwtMiddleware,
  asyncHandler(migrationController.executeMigration)
);
router.get(
  "/verify",
  jwtMiddleware,
  asyncHandler(migrationController.verifyMigration)
);
router.post(
  "/rollback",
  jwtMiddleware,
  asyncHandler(migrationController.rollbackMigration)
);
router.post(
  "/cleanup",
  jwtMiddleware,
  asyncHandler(migrationController.cleanupOldFields)
);

module.exports = router;
