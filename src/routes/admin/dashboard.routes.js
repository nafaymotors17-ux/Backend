const express = require("express");
const router = express.Router();
const dashboardController = require("../../controllers/admin.dashboard.controller");
const jwtMiddleware = require("../../middlewares/jwt.middleware");
const asyncHandler = require("../../utils/asyncHandler");

// Apply JWT middleware to all dashboard routes
router.use(jwtMiddleware);

// Dashboard stats routes
router.get("/dashboard/stats", asyncHandler(dashboardController.getDashboardStats));
router.get("/dashboard/shipment-stats", asyncHandler(dashboardController.getShipmentStats));
router.get("/dashboard/user-stats", asyncHandler(dashboardController.getUserStats));
router.get("/dashboard/system-overview", asyncHandler(dashboardController.getSystemOverview));

module.exports = router;