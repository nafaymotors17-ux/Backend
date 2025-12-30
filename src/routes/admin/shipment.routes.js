const express = require("express");
const router = express.Router();
const jwtMiddleware = require("../../middlewares/jwt.middleware");
const shipmentController = require("../../controllers/shipment/shipment.controller");
const Shipment = require("../../models/shipment.model");
// Apply JWT middleware to all shipment routes
// router.use(jwtMiddleware);

// Shipment CRUD routes
router.get("/testing", async (req, res) => {
  const start = Date.now();

  try {
    // ⚡ Fetch all docs with lean() for faster performance

    const shipments = await Shipment.find();
    const shipments1 = await Shipment.find();
    const shipments2 = await Shipment.find();
    const duration = Date.now() - start;
    res.status(200).json({
      success: true,
      count: shipments.length + shipments1.length + shipments2.length,
      durationMs: duration,
      message: `Fetched ${
        shipments.length + shipments1.length + shipments2.length
      } shipments in ${duration} ms`,
      data: {
        ...shipments,
        shipments1,
        shipments2,
      },
    });
  } catch (err) {
    console.error("Error fetching shipments:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/create", shipmentController.createShipment);
router.put("/update/:id", jwtMiddleware, shipmentController.updateShipment);
router.post("/updateRemarks", jwtMiddleware, shipmentController.updateRemarks);
router.delete("/delete/:id", jwtMiddleware, shipmentController.deleteShipment);
router.post("/delete", jwtMiddleware, shipmentController.deleteShipments);
router.get("/list", shipmentController.listShipments);
router.get("/:id", jwtMiddleware, shipmentController.getShipmentById);
router.get("/export/csv", shipmentController.exportShipmentsExcel);

module.exports = router;
