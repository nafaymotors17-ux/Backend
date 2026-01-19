const express = require("express");
const router = express.Router();
const vesselController = require("../../controllers/vessel.controller");
const jwtMiddleware = require("../../middlewares/jwt.middleware");
const asyncHandler = require("../../utils/asyncHandler");

// Role-based middleware
const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ 
      success: false,
      message: "Access denied. Admin role required." 
    });
  }
  next();
};

// Vessel CRUD routes
router.get("/list", asyncHandler(vesselController.listVessels));
router.get("/search", asyncHandler(vesselController.searchVessels));
router.get("/:id", asyncHandler(vesselController.getVesselById));

// Create - Admin only (subadmin cannot create)
router.post(
  "/create",
  jwtMiddleware,
  adminOnly,
  asyncHandler(vesselController.createVessel)
);

// Update - Admin only (subadmin cannot edit)
router.put(
  "/update/:id",
  jwtMiddleware,
  adminOnly,
  asyncHandler(vesselController.updateVessel)
);

// Delete - Disabled for all roles (admin cannot delete, only edit)
// router.delete(
//   "/delete/:id",
//   jwtMiddleware,
//   asyncHandler(vesselController.deleteVessel)
// );

module.exports = router;
