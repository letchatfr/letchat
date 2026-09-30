export const interests = {
  musique: "Musique", cinema: "Cinéma et séries", jeux: "Jeux vidéo",
  sport: "Sport", voyages: "Voyages", cuisine: "Cuisine", quotidien: "Vie quotidienne",
};
export const normalizeInterests = value => Array.isArray(value)
  ? [...new Set(value.filter(item => typeof item === "string" && Object.hasOwn(interests, item)))].slice(0, 3) : [];
export const shareInterests = (a, b) => !a.length || !b.length || a.some(item => b.includes(item));
