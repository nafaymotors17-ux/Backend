const express = require("express");
const router = express.Router();
const clientController = require("../controllers/client.controller");
const jwtMiddleware = require("../middlewares/jwt.middleware");
const asyncHandler = require("../utils/asyncHandler");

router.get(
  "/shipments/export/csv/:customerId",
  asyncHandler(clientController.exportMyShipmentsExcel)
);
// Apply JWT middleware to all customer routes
router.use(jwtMiddleware);

// Customer shipment routes - customer can only see their own shipments
router.get("/get/shipments", asyncHandler(clientController.getMyShipments));
router.get(
  "/get/shipment/:id",
  asyncHandler(clientController.getMyShipmentById)
);
router.get(
  "/shipments/stats/overview",
  asyncHandler(clientController.getShipmentOverview)
);

module.exports = router;
