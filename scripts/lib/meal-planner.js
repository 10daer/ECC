'use strict';

const DEFAULT_RECIPES = [
  {
    id: 'chickpea-curry',
    name: 'Chickpea Curry',
    tags: ['vegetarian', 'comfort'],
    ingredients: [
      { name: 'chickpeas', quantity: 2, unit: 'cans' },
      { name: 'tomatoes', quantity: 1, unit: 'can' },
      { name: 'onion', quantity: 1, unit: 'each' },
      { name: 'curry powder', quantity: 1, unit: 'tbsp' },
    ],
  },
  {
    id: 'salmon-rice-bowl',
    name: 'Salmon Rice Bowl',
    tags: ['high-protein', 'quick'],
    ingredients: [
      { name: 'salmon', quantity: 2, unit: 'fillets' },
      { name: 'rice', quantity: 1, unit: 'cup' },
      { name: 'cucumber', quantity: 1, unit: 'each' },
      { name: 'soy sauce', quantity: 2, unit: 'tbsp' },
    ],
  },
  {
    id: 'chicken-pasta',
    name: 'Garlic Chicken Pasta',
    tags: ['high-protein', 'comfort'],
    ingredients: [
      { name: 'chicken breast', quantity: 2, unit: 'each' },
      { name: 'pasta', quantity: 8, unit: 'oz' },
      { name: 'garlic', quantity: 3, unit: 'cloves' },
      { name: 'parmesan', quantity: 0.5, unit: 'cup' },
    ],
  },
  {
    id: 'veggie-tacos',
    name: 'Veggie Tacos',
    tags: ['vegetarian', 'quick'],
    ingredients: [
      { name: 'black beans', quantity: 1, unit: 'can' },
      { name: 'tortillas', quantity: 6, unit: 'each' },
      { name: 'bell pepper', quantity: 1, unit: 'each' },
      { name: 'avocado', quantity: 1, unit: 'each' },
    ],
  },
  {
    id: 'oatmeal',
    name: 'Berry Oatmeal',
    tags: ['vegetarian', 'breakfast', 'quick'],
    ingredients: [
      { name: 'oats', quantity: 0.5, unit: 'cup' },
      { name: 'milk', quantity: 1, unit: 'cup' },
      { name: 'berries', quantity: 0.5, unit: 'cup' },
    ],
  },
];

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function createState(overrides = {}) {
  return {
    inventory: Array.isArray(overrides.inventory) ? overrides.inventory.map(normalizeInventoryItem) : [],
    preferences: {
      likes: Array.isArray(overrides.preferences?.likes) ? overrides.preferences.likes.map(normalizeName) : [],
      dislikes: Array.isArray(overrides.preferences?.dislikes) ? overrides.preferences.dislikes.map(normalizeName) : [],
    },
    plan: Array.isArray(overrides.plan) ? overrides.plan.map(item => ({ ...item })) : [],
    completed: Array.isArray(overrides.completed) ? [...overrides.completed] : [],
  };
}

function normalizeInventoryItem(item) {
  const quantity = Number(item.quantity);
  if (!normalizeName(item.name) || !Number.isFinite(quantity) || quantity < 0) {
    throw new TypeError('Inventory items require a name and non-negative quantity.');
  }
  return {
    name: normalizeName(item.name),
    quantity,
    unit: String(item.unit || 'each').trim() || 'each',
  };
}

function upsertInventory(state, item) {
  const next = createState(state);
  const normalized = normalizeInventoryItem(item);
  const existingIndex = next.inventory.findIndex(entry => entry.name === normalized.name && entry.unit === normalized.unit);
  if (existingIndex === -1) {
    next.inventory = [...next.inventory, normalized];
  } else {
    next.inventory = next.inventory.map((entry, index) => index === existingIndex
      ? { ...entry, quantity: entry.quantity + normalized.quantity }
      : entry);
  }
  return next;
}

function restockInventory(state, item) {
  return upsertInventory(state, item);
}

function setPreferences(state, preferences) {
  return {
    ...createState(state),
    preferences: {
      likes: [...new Set((preferences.likes || []).map(normalizeName).filter(Boolean))],
      dislikes: [...new Set((preferences.dislikes || []).map(normalizeName).filter(Boolean))],
    },
  };
}

function pantryQuantity(inventory, ingredient) {
  return inventory
    .filter(item => item.name === normalizeName(ingredient.name) && item.unit === ingredient.unit)
    .reduce((sum, item) => sum + item.quantity, 0);
}

function suggestRecipes(state, recipes = DEFAULT_RECIPES, limit = 5) {
  const current = createState(state);
  const dislikes = new Set(current.preferences.dislikes);
  const likes = new Set(current.preferences.likes);
  return recipes
    .filter(recipe => !recipe.ingredients.some(ingredient => dislikes.has(normalizeName(ingredient.name))))
    .map(recipe => {
      const pantryMatches = recipe.ingredients.filter(ingredient => pantryQuantity(current.inventory, ingredient) >= ingredient.quantity).length;
      const preferenceMatches = recipe.tags.filter(tag => likes.has(normalizeName(tag))).length;
      return {
        ...recipe,
        score: pantryMatches * 3 + preferenceMatches * 2 - (recipe.ingredients.length - pantryMatches),
        pantryMatches,
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function generateWeeklyPlan(state, recipes = DEFAULT_RECIPES, days = DAYS) {
  const suggestions = suggestRecipes(state, recipes, recipes.length);
  if (suggestions.length === 0) return [];
  return days.map((day, index) => {
    const recipe = suggestions[index % suggestions.length];
    return { day, recipeId: recipe.id, recipeName: recipe.name };
  });
}

function generateGroceryList(state, recipes = DEFAULT_RECIPES) {
  const current = createState(state);
  const needed = new Map();
  current.plan.forEach(entry => {
    const recipe = recipes.find(item => item.id === entry.recipeId);
    if (!recipe) return;
    recipe.ingredients.forEach(ingredient => {
      const key = `${normalizeName(ingredient.name)}|${ingredient.unit}`;
      const existing = needed.get(key) || { ...ingredient, name: normalizeName(ingredient.name), quantity: 0 };
      needed.set(key, { ...existing, quantity: existing.quantity + ingredient.quantity });
    });
  });
  return [...needed.values()]
    .map(item => ({ ...item, quantity: Math.max(0, item.quantity - pantryQuantity(current.inventory, item)) }))
    .filter(item => item.quantity > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function consumeRecipe(state, recipeId, recipes = DEFAULT_RECIPES) {
  const current = createState(state);
  const recipe = recipes.find(item => item.id === recipeId);
  if (!recipe) throw new Error(`Unknown recipe: ${recipeId}`);
  const inventory = current.inventory.map(item => {
    const ingredient = recipe.ingredients.find(required => required.name === item.name && required.unit === item.unit);
    return ingredient ? { ...item, quantity: Math.max(0, item.quantity - ingredient.quantity) } : item;
  });
  return { ...current, inventory, completed: [...current.completed, recipeId] };
}

module.exports = {
  DAYS,
  DEFAULT_RECIPES,
  consumeRecipe,
  createState,
  generateGroceryList,
  generateWeeklyPlan,
  normalizeName,
  restockInventory,
  setPreferences,
  suggestRecipes,
  upsertInventory,
};
