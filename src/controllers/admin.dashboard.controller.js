const Shipment = require("../models/shipment.model");
const User = require("../models/user.model");
const Car = require("../models/car.model");
const ApiError = require("../utils/api.error");
const ApiResponse = require("../utils/api.response");
const asyncHandler = require("../utils/asyncHandler");

/**
 * Get main dashboard overview stats
 */
exports.getDashboardStats = asyncHandler(async (req, res) => {
    const [
        totalShipments,
        shipmentStatusStats,
        totalUsers,
        userRoleStats,
        recentShipments,
        todayShipmentsCount
    ] = await Promise.all([
        // Total shipments count
        Shipment.countDocuments(),

        // Shipment status statistics
        Shipment.aggregate([
            {
                $group: {
                    _id: '$exportStatus',
                    count: { $sum: 1 }
                }
            }
        ]),

        // Total users count
        User.countDocuments(),

        // User role statistics
        User.aggregate([
            {
                $group: {
                    _id: '$role',
                    count: { $sum: 1 }
                }
            }
        ]),

        // Recent shipments (last 5)
        Shipment.find()
            .sort({ createdAt: -1 })
            .limit(5)
            .populate('clientId', 'username')
            .populate('carId', 'chassisNumber makeModel')
            .select('vesselName yardLocation gateInDate gateOutDate exportStatus carId clientId'),

        // Today's shipments count
        Shipment.countDocuments({
            createdAt: {
                $gte: new Date(new Date().setHours(0, 0, 0, 0)),
                $lt: new Date(new Date().setHours(23, 59, 59, 999))
            }
        })
    ]);

    // Process shipment status stats
    const statusStats = {
        pending: 0,
        exported: 0,
        delayed: 0,
        cancelled: 0
    };

    shipmentStatusStats.forEach(stat => {
        statusStats[stat._id] = stat.count;
    });

    // Process user role stats
    const roleStats = {
        admin: 0,
        customer: 0
    };

    userRoleStats.forEach(stat => {
        roleStats[stat._id] = stat.count;
    });

    // Calculate completion rate
    const totalCompleted = statusStats.exported + statusStats.cancelled;
    const completionRate = totalShipments > 0 ? Math.round((totalCompleted / totalShipments) * 100) : 0;

    const dashboardStats = {
        overview: {
            totalShipments,
            todayShipments: todayShipmentsCount,
            completionRate,
            totalUsers,
            activeUsers: totalUsers, // You can add active status logic later
            pendingShipments: statusStats.pending,
            cancelledShipments: statusStats.cancelled
        },
        shipmentStats: statusStats,
        userStats: roleStats,
        recentShipments
    };

    const response = ApiResponse.success(
        "Dashboard stats retrieved successfully",
        dashboardStats
    );

    res.status(response.statusCode).json(response);
});

/**
 * Get detailed shipment statistics
 */
exports.getShipmentStats = asyncHandler(async (req, res) => {
    const { period = 'all' } = req.query; // all, monthly, weekly, yearly

    let dateFilter = {};
    const now = new Date();

    switch (period) {
        case 'weekly':
            dateFilter = {
                gateInDate: {
                    $gte: new Date(now.setDate(now.getDate() - 7))
                }
            };
            break;
        case 'monthly':
            dateFilter = {
                gateInDate: {
                    $gte: new Date(now.getFullYear(), now.getMonth(), 1)
                }
            };
            break;
        case 'yearly':
            dateFilter = {
                gateInDate: {
                    $gte: new Date(now.getFullYear(), 0, 1)
                }
            };
            break;
        // 'all' - no date filter
    }

    const [
        statusStats,
        monthlyTrend,
        vesselStats,
        yardStats,
        topClients
    ] = await Promise.all([
        // Status statistics
        Shipment.aggregate([
            { $match: dateFilter },
            {
                $group: {
                    _id: '$exportStatus',
                    count: { $sum: 1 }
                }
            }
        ]),

        // Monthly trend
        Shipment.aggregate([
            { $match: dateFilter },
            {
                $group: {
                    _id: {
                        year: { $year: '$gateInDate' },
                        month: { $month: '$gateInDate' }
                    },
                    count: { $sum: 1 }
                }
            },
            { $sort: { '_id.year': -1, '_id.month': -1 } },
            { $limit: 12 }
        ]),

        // Vessel statistics
        Shipment.aggregate([
            { $match: dateFilter },
            {
                $group: {
                    _id: '$vesselName',
                    count: { $sum: 1 }
                }
            },
            { $sort: { count: -1 } },
            { $limit: 10 }
        ]),

        // Yard location statistics
        Shipment.aggregate([
            { $match: dateFilter },
            {
                $group: {
                    _id: '$yardLocation',
                    count: { $sum: 1 }
                }
            },
            { $sort: { count: -1 } },
            { $limit: 10 }
        ]),

        // Top clients
        Shipment.aggregate([
            { $match: dateFilter },
            {
                $group: {
                    _id: '$clientId',
                    count: { $sum: 1 }
                }
            },
            { $sort: { count: -1 } },
            { $limit: 10 },
            {
                $lookup: {
                    from: 'users',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'client'
                }
            },
            {
                $unwind: '$client'
            },
            {
                $project: {
                    'client.username': 1,
                    'client.email': 1,
                    count: 1
                }
            }
        ])
    ]);

    // Process status stats
    const processedStatusStats = {
        pending: 0,
        exported: 0,
        delayed: 0,
        cancelled: 0
    };

    statusStats.forEach(stat => {
        processedStatusStats[stat._id] = stat.count;
    });

    const shipmentStats = {
        period,
        statusStats: processedStatusStats,
        monthlyTrend,
        vesselStats,
        yardStats,
        topClients,
        totalShipments: statusStats.reduce((sum, stat) => sum + stat.count, 0)
    };

    const response = ApiResponse.success(
        "Shipment statistics retrieved successfully",
        shipmentStats
    );

    res.status(response.statusCode).json(response);
});

/**
 * Get user management statistics
 */
exports.getUserStats = asyncHandler(async (req, res) => {
    const [
        roleStats,
        registrationTrend,
        recentRegistrations,
        usersWithShipments
    ] = await Promise.all([
        // Role statistics
        User.aggregate([
            {
                $group: {
                    _id: '$role',
                    count: { $sum: 1 }
                }
            }
        ]),

        // Registration trend (last 6 months)
        User.aggregate([
            {
                $group: {
                    _id: {
                        year: { $year: '$createdAt' },
                        month: { $month: '$createdAt' }
                    },
                    count: { $sum: 1 }
                }
            },
            { $sort: { '_id.year': -1, '_id.month': -1 } },
            { $limit: 6 }
        ]),

        // Recent registrations
        User.find()
            .sort({ createdAt: -1 })
            .limit(5)
            .select('username email role createdAt'),

        // Users with shipments count
        Shipment.aggregate([
            {
                $group: {
                    _id: '$clientId',
                    shipmentCount: { $sum: 1 }
                }
            },
            {
                $lookup: {
                    from: 'users',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'user'
                }
            },
            {
                $unwind: '$user'
            },
            {
                $project: {
                    'user.username': 1,
                    'user.email': 1,
                    'user.role': 1,
                    shipmentCount: 1
                }
            },
            { $sort: { shipmentCount: -1 } },
            { $limit: 10 }
        ])
    ]);

    // Process role stats
    const processedRoleStats = {
        admin: 0,
        customer: 0
    };

    roleStats.forEach(stat => {
        processedRoleStats[stat._id] = stat.count;
    });

    const userStats = {
        roleStats: processedRoleStats,
        registrationTrend,
        recentRegistrations,
        usersWithShipments,
        totalUsers: roleStats.reduce((sum, stat) => sum + stat.count, 0)
    };

    const response = ApiResponse.success(
        "User statistics retrieved successfully",
        userStats
    );

    res.status(response.statusCode).json(response);
});

/**
 * Get system overview for quick stats
 */
exports.getSystemOverview = asyncHandler(async (req, res) => {
    const [
        totalShipments,
        totalUsers,
        totalCars,
        todayShipments,
        pendingShipments
    ] = await Promise.all([
        Shipment.countDocuments(),
        User.countDocuments(),
        Car.countDocuments(),
        Shipment.countDocuments({
            createdAt: {
                $gte: new Date(new Date().setHours(0, 0, 0, 0))
            }
        }),
        Shipment.countDocuments({ exportStatus: 'pending' })
    ]);

    const systemOverview = {
        totalShipments,
        totalUsers,
        totalCars,
        todayShipments,
        pendingShipments
    };

    const response = ApiResponse.success(
        "System overview retrieved successfully",
        systemOverview
    );

    res.status(response.statusCode).json(response);
});