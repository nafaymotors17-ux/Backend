const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const User = require("../models/user.model");
const ApiError = require("../utils/api.error");
const ApiResponse = require("../utils/api.response");
const asyncHandler = require("../utils/asyncHandler");
const Shipments = require("../models/shipment.model");

exports.listUsers = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    role,
    search,
    sortBy = "createdAt",
    sortOrder = "desc",
  } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit, 10)));

  // --- Build filter ---
  const filter = {};
  if (role) filter.role = role.toLowerCase();
  if (search) {
    filter.$or = [
      { userId: { $regex: search, $options: "i" } },
      { name: { $regex: search, $options: "i" } },
    ];
  }

  // --- Sort safely ---
  const allowedSortFields = ["createdAt", "name", "userId", "role"];
  const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : "createdAt";
  const sortOptions = { [safeSortBy]: sortOrder === "desc" ? -1 : 1 };

  // --- Fetch from DB ---
  const totalUserCount = await User.countDocuments();
  const result = await User.paginate(filter, {
    page: pageNum,
    limit: limitNum,
    sort: sortOptions,
    select: "-refreshToken -updatedAt -__v",
  });

  const response = ApiResponse.paginated(
    "Users retrieved successfully",
    result.docs,
    {
      currentPage: result.page,
      totalPages: result.totalPages,
      totalUsers: result.totalDocs,
      usersPerPage: result.limit,
      hasNextPage: result.hasNextPage,
      hasPrevPage: result.hasPrevPage,
      totalUserCount: totalUserCount - 1,
    }
  );

  res.status(200).json(response);
});
exports.createUser = asyncHandler(async (req, res) => {
  const { name, username: userId, password } = req.body;

  // --- 1️⃣ Basic validation ---
  if (!name || !userId || !password) {
    throw ApiError.badRequest(
      "Customer name, userId and password are required"
    );
  }

  if (password.length < 6) {
    throw ApiError.badRequest("Password must be at least 6 characters long");
  }

  if (userId.length < 4) {
    throw ApiError.badRequest("userId must be at least 4 characters long");
  }

  // --- 2️⃣ Normalize inputs ---
  const normalizedName = name.trim().toUpperCase();
  const normalizedUserId = userId.trim().toLowerCase();
  const normalizedPassword = password.trim();

  // --- 3️⃣ Check for existing users ---
  const existingUsers = await User.find({
    $or: [
      { name: new RegExp(`^${normalizedName}$`, "i") },
      { userId: normalizedUserId },
    ],
  }).select("name userId");

  const existingUser = existingUsers.find(
    (u) => u.name.trim().toUpperCase() === normalizedName
  );
  const existingUserId = existingUsers.find(
    (u) => u.userId.trim().toLowerCase() === normalizedUserId
  );

  if (existingUserId) {
    throw ApiError.conflict("User with given userId already exists");
  }

  // --- 4️⃣ Create user ---
  const newUser = await User.create({
    name: normalizedName,
    userId: normalizedUserId,
    password: normalizedPassword,
  });

  // --- 5️⃣ Prepare response payload ---
  const userResponse = {
    _id: newUser._id,
    userId: newUser.userId,
    name: newUser.name,
    role: newUser.role,
    createdAt: newUser.createdAt,
    duplicateWarnning: existingUser
      ? "A user with the same name already exists"
      : null,
  };

  // --- 6️⃣ Send success ---
  const response = ApiResponse.created(
    "User created successfully",
    userResponse
  );

  return res.status(response.statusCode).json(response);
});

/**
 * Update an existing user
 */
exports.updateUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, password, username: newUserId } = req.body;

  // Prevent admin from modifying their own profile
  if (req.user?.userId === "admin@123" && req.user?._id?.toString() === id) {
    throw ApiError.forbidden("You cannot modify your own admin profile");
  }

  const user = await User.findById(id);
  if (!user) {
    throw ApiError.notFound("User not found");
  }

  const updateFields = {};

  // === 1️⃣ Handle User ID update (unique + validated)
  if (newUserId && newUserId.trim().toLowerCase() !== user.userId) {
    const normalizedId = newUserId.trim().toLowerCase();

    // Validate username pattern
    if (!/^[a-z0-9_]+$/.test(normalizedId)) {
      throw ApiError.badRequest(
        "User ID can only contain lowercase letters, numbers, and underscores"
      );
    }

    // Ensure uniqueness
    const exists = await User.exists({
      userId: normalizedId,
      _id: { $ne: id },
    });
    if (exists) {
      throw ApiError.conflict(`User ID '${normalizedId}' already exists.`);
    }

    updateFields.userId = normalizedId;
  }

  // === 2️⃣ Handle Name update
  if (name && name.trim() !== user.name) {
    updateFields.name = name.trim();
  }

  // === 3️⃣ Handle Password update (optional)
  if (password && password.trim()) {
    if (password.length < 6) {
      throw ApiError.badRequest("Password must be at least 6 characters long");
    }
    user.password = password.trim(); // pre-save hashing
    await user.save({ validateBeforeSave: false });
  }

  // === 4️⃣ Apply other updates if needed
  let updatedUser = user;
  if (Object.keys(updateFields).length > 0) {
    updatedUser = await User.findByIdAndUpdate(
      id,
      { $set: updateFields },
      { new: true, runValidators: true, select: "-password" }
    );
  }

  // === 5️⃣ Respond
  return res
    .status(200)
    .json(ApiResponse.success("User updated successfully", updatedUser));
});

/**
 * Delete a user
 */
exports.deleteUser = async (req, res) => {
  const { id } = req.params;
  // Prevent self-deletion
  if (req?.user?._id.toString() === id) {
    throw ApiError.forbidden("You cannot delete your own account");
  }

  const user = await User.findByIdAndDelete(id);
  if (!user) {
    throw ApiError.notFound("User not found");
  }

  const shipments = await Shipments.deleteMany({ clientId: user._id });

  if (shipments.deletedCount <= 0) {
    console.log("No shipments for : ", user.userId);
  }
  const response = ApiResponse.success("User deleted successfully", {
    _id: user._id,
    totalShipmentsDeleted: shipments.deletedCount,
  });
  res.status(response.statusCode).json(response);
};

/**
 * Get user by ID
 */
exports.getUserById = async (req, res) => {
  const { id } = req.params;

  const user = await User.findById(id).select("-password");

  if (!user) {
    throw ApiError.notFound("User not found");
  }

  const response = ApiResponse.success("User retrieved successfully", user);

  res.status(response.statusCode).json(response);
};
