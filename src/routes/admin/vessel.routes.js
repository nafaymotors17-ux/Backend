const express = require("express");
const router = express.Router();
const vesselController = require("../../controllers/vessel.controller");
const jwtMiddleware = require("../../middlewares/jwt.middleware");
const asyncHandler = require("../../utils/asyncHandler");

// Vessel CRUD routes
router.get("/list", asyncHandler(vesselController.listVessels));
router.get("/search", asyncHandler(vesselController.searchVessels));
router.post(
  "/create",
  jwtMiddleware,
  asyncHandler(vesselController.createVessel)
);
router.get("/:id", jwtMiddleware, asyncHandler(vesselController.getVesselById));
router.put(
  "/update/:id",
  jwtMiddleware,
  asyncHandler(vesselController.updateVessel)
);
router.delete(
  "/delete/:id",
  jwtMiddleware,
  asyncHandler(vesselController.deleteVessel)
);

module.exports = router;
