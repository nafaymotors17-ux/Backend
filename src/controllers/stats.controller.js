const Shipment = require("../models/shipment.model");
const User = require("../models/user.model");

exports.getStats = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Fetch stats
    const [shipmentStats, userStats] = await Promise.all([
      Shipment.aggregate([
        {
          $facet: {
            overall: [
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  shipped: {
                    $sum: {
                      $cond: [{ $eq: ["$exportStatus", "shipped"] }, 1, 0],
                    },
                  },
                  unshipped: {
                    $sum: {
                      $cond: [{ $eq: ["$exportStatus", "unshipped"] }, 1, 0],
                    },
                  },
                  pending: {
                    $sum: {
                      $cond: [{ $eq: ["$exportStatus", "pending"] }, 1, 0],
                    },
                  },
                  cancelled: {
                    $sum: {
                      $cond: [{ $eq: ["$exportStatus", "cancelled"] }, 1, 0],
                    },
                  },
                },
              },
            ],
            today: [
              { $match: { createdAt: { $gte: today, $lt: tomorrow } } },
              { $count: "count" },
            ],
          },
        },
      ]).exec(),

      User.aggregate([
        { $match: { role: "customer" } },
        {
          $facet: {
            total: [{ $count: "count" }],
            today: [
              { $match: { createdAt: { $gte: today, $lt: tomorrow } } },
              { $count: "count" },
            ],
          },
        },
      ]).exec(),
    ]);

    // Extract stats
    const overallData = shipmentStats[0]?.overall[0] || {
      total: 0,
      shipped: 0,
      unshipped: 0,
      pending: 0,
      cancelled: 0,
    };
    const todayShipments = shipmentStats[0]?.today[0]?.count || 0;
    const totalUsers = userStats[0]?.total[0]?.count || 0;
    const todayUsers = userStats[0]?.today[0]?.count || 0;

    res.json({
      success: true,
      data: {
        totalShipments: overallData.total,
        shipped: overallData.shipped,
        unshipped: overallData.unshipped,
        pending: overallData.pending,
        cancelled: overallData.cancelled,

        todayShipments,
        totalUsers,
        todayUsers,
      },
    });
  } catch (error) {
    console.error("Stats error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching dashboard statistics",
    });
  }
};

// controllers/gateStatsController.js

exports.getGateStats = async (req, res) => {
  try {
    const { period = "month", year = new Date().getFullYear() } = req.query;

    const today = new Date();
    let startDate, endDate;

    // Calculate date ranges based on period
    switch (period) {
      case "today":
        startDate = new Date(today);
        startDate.setHours(0, 0, 0, 0);
        endDate = new Date(today);
        endDate.setHours(23, 59, 59, 999);
        break;
      case "month":
        startDate = new Date(today.getFullYear(), today.getMonth(), 1);
        endDate = new Date(today);
        endDate.setHours(23, 59, 59, 999);
        break;
      case "year":
        startDate = new Date(year, 0, 1);
        endDate = new Date(year, 11, 31, 23, 59, 59, 999);
        break;
      default:
        startDate = new Date(today.getFullYear(), today.getMonth(), 1);
        endDate = new Date(today);
        endDate.setHours(23, 59, 59, 999);
    }

    const startOfYear = new Date(year, 0, 1);
    const endOfYear = new Date(year, 11, 31, 23, 59, 59, 999);

    // Single $facet aggregation
    const stats = await Shipment.aggregate([
      {
        $facet: {
          gateInStats: [
            { $match: { gateInDate: { $gte: startDate, $lte: endDate } } },
            { $count: "count" },
          ],
          gateOutStats: [
            { $match: { gateOutDate: { $gte: startDate, $lte: endDate } } },
            { $count: "count" },
          ],
          gateInStatus: [
            { $match: { gateInDate: { $gte: startDate, $lte: endDate } } },
            { $group: { _id: "$exportStatus", count: { $sum: 1 } } },
          ],
          inYardStats: [{ $match: { storageDays: 0 } }, { $count: "count" }],
          monthlyGateIn: [
            { $match: { gateInDate: { $gte: startOfYear, $lte: endOfYear } } },
            { $group: { _id: { $month: "$gateInDate" }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ],
          monthlyGateOut: [
            { $match: { gateOutDate: { $gte: startOfYear, $lte: endOfYear } } },
            { $group: { _id: { $month: "$gateOutDate" }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ],
          yearlyGateIn: [
            { $match: { gateInDate: { $ne: null } } },
            { $group: { _id: { $year: "$gateInDate" }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ],
          yearlyGateOut: [
            { $match: { gateOutDate: { $ne: null } } },
            { $group: { _id: { $year: "$gateOutDate" }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ],
        },
      },
    ]);

    const {
      gateInStats,
      gateOutStats,
      gateInStatus,
      inYardStats,
      monthlyGateIn,
      monthlyGateOut,
      yearlyGateIn,
      yearlyGateOut,
    } = stats[0];

    const gateInCount = gateInStats[0]?.count || 0;
    const gateOutCount = gateOutStats[0]?.count || 0;
    const inYardCount = inYardStats[0]?.count || 0;

    const statusBreakdown = {
      shipped: 0,
      unshipped: 0,
      pending: 0,
      cancelled: 0,
    };
    gateInStatus.forEach((item) => {
      if (statusBreakdown.hasOwnProperty(item._id)) {
        statusBreakdown[item._id] = item.count;
      }
    });

    const chartData = processMonthlyData(monthlyGateIn, monthlyGateOut);
    const yearlyData = processYearlyData(yearlyGateIn, yearlyGateOut);

    res.json({
      success: true,
      data: {
        period,
        year: parseInt(year),
        summary: {
          gateIn: gateInCount,
          gateOut: gateOutCount,
          inYard: inYardCount,
          netFlow: gateInCount - gateOutCount,
        },
        statusBreakdown: {
          gateIn: statusBreakdown,
        },
        chartData,
        yearlyData,
      },
    });
  } catch (error) {
    console.error("Gate stats error:", error);
    res
      .status(500)
      .json({ success: false, message: "Error fetching gate statistics" });
  }
};

function processMonthlyData(monthlyGateIn, monthlyGateOut) {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const gateInMonthly = new Array(12).fill(0);
  const gateOutMonthly = new Array(12).fill(0);

  monthlyGateIn.forEach((item) => {
    gateInMonthly[item._id - 1] = item.count;
  });

  monthlyGateOut.forEach((item) => {
    gateOutMonthly[item._id - 1] = item.count;
  });

  return {
    labels: months,
    datasets: [
      {
        label: "Gate In",
        data: gateInMonthly,
        backgroundColor: "rgba(59, 130, 246, 0.8)",
        borderColor: "rgb(59, 130, 246)",
        borderWidth: 2,
      },
      {
        label: "Gate Out",
        data: gateOutMonthly,
        backgroundColor: "rgba(34, 197, 94, 0.8)",
        borderColor: "rgb(34, 197, 94)",
        borderWidth: 2,
      },
    ],
  };
}

function processYearlyData(yearlyGateIn, yearlyGateOut) {
  const gateInByYear = {};
  const gateOutByYear = {};

  yearlyGateIn.forEach((item) => {
    gateInByYear[item._id] = item.count;
  });

  yearlyGateOut.forEach((item) => {
    gateOutByYear[item._id] = item.count;
  });

  const years = [
    ...new Set([...Object.keys(gateInByYear), ...Object.keys(gateOutByYear)]),
  ].sort();

  return {
    labels: years,
    datasets: [
      {
        label: "Gate In",
        data: years.map((year) => gateInByYear[year] || 0),
        backgroundColor: "rgba(59, 130, 246, 0.6)",
      },
      {
        label: "Gate Out",
        data: years.map((year) => gateOutByYear[year] || 0),
        backgroundColor: "rgba(34, 197, 94, 0.6)",
      },
    ],
  };
}
