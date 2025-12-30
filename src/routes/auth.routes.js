const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");
const jwtMiddleware = require("../middlewares/jwt.middleware");
const asyncHandler = require("../utils/asyncHandler");

// Public routes
router.post("/login", asyncHandler(authController.login));
router.post("/refresh", asyncHandler(authController.refreshToken));
// Protected routes
router.post("/logout", asyncHandler(authController.logout));
// Token validation route
router.get(
  "/validateToken",
  jwtMiddleware,
  asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    return res.status(200).json({
      success: true,
      user: {
        userId: req.user._id,
        name: req.user.name,
        role: req.user.role,
        createdAt: req.user.createdAt,
      },
    });
  })
);

module.exports = router;
