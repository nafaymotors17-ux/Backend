const express = require("express");
const router = express.Router();
const adminController = require("../../controllers/admin.controller");
const statsController = require("../../controllers/stats.controller");
const jwtMiddleware = require("../../middlewares/jwt.middleware");
const asyncHandler = require("../../utils/asyncHandler");
const importExcelController = require("../../controllers/importExcel");
// Apply JWT middleware to all admin routes
// router.use(jwtMiddleware);

// User CRUD routes
router.post("/create/user", asyncHandler(adminController.createUser));
router.get("/list/users", asyncHandler(adminController.listUsers));
router.get("/get/user/:id", asyncHandler(adminController.getUserById));
router.put(
  "/update/user/:id",
  jwtMiddleware,
  asyncHandler(adminController.updateUser)
);
router.delete(
  "/delete/user/:id",
  jwtMiddleware,
  asyncHandler(adminController.deleteUser)
);
router.get("/stats/dashboard", statsController.getStats);
router.get("/stats/gates", statsController.getGateStats);

router.post("/excel", importExcelController.fixShipmentDates);
module.exports = router;
