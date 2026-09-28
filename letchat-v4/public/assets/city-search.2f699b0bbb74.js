// Rows are ordered by population so familiar places come first within a match group.
export function normalizeCity(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr").replace(/œ/g, "oe").replace(/æ/g, "ae")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/^st /, "saint ").replace(/^ste /, "sainte ");
}

export function createCityIndex(rows) {
  return rows.map(([name, department, postcodes]) => ({
    name, department, postcodes: postcodes ? postcodes.split(",") : [], key: normalizeCity(name),
  }));
}

export function findCities(index, value, limit = 8) {
  const query = normalizeCity(value);
  if (query.length < 2) return [];
  const numeric = /^\d+$/.test(query), groups = [[], [], []];
  for (const city of index) {
    const rank = numeric
      ? city.postcodes.some(code => code === query) ? 0 : city.postcodes.some(code => code.startsWith(query)) ? 1 : -1
      : city.key.startsWith(query) ? 0 : city.key.includes(` ${query}`) ? 1 : city.key.includes(query) ? 2 : -1;
    if (rank >= 0 && groups[rank].length < limit) groups[rank].push(city);
  }
  return groups.flat().slice(0, limit);
}
