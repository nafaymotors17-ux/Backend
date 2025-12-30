exports.calculateStoragePeriod = (gateInDate, gateOutDate) => {
  if (!gateInDate) return 0;

  const inDate = new Date(gateInDate);
  const outDate = gateOutDate ? new Date(gateOutDate) : new Date();

  inDate.setHours(0, 0, 0, 0);
  outDate.setHours(0, 0, 0, 0);

  if (outDate < inDate) return 0;

  const diffTime = outDate - inDate;
  return Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1;
};
