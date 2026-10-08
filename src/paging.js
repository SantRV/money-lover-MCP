export const pageItems = (items, { limit, offset = 0, maxLimit = 1000 } = {}) => {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  if (limit == null) {
    return {
      items: list.slice(start),
      total,
      returned: Math.max(0, total - start),
      truncated: false,
      offset: start
    };
  }
  const size = Math.min(Math.max(1, Math.floor(limit)), maxLimit);
  const end = Math.min(total, start + size);
  return {
    items: list.slice(start, end),
    total,
    returned: Math.max(0, end - start),
    truncated: end < total,
    offset: start
  };
};
