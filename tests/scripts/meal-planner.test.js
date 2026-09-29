'use strict';

const assert = require('assert');
const {
  consumeRecipe,
  createState,
  generateGroceryList,
  generateWeeklyPlan,
  restockInventory,
  setPreferences,
  suggestRecipes,
  upsertInventory,
} = require('../../scripts/lib/meal-planner');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (error) { console.log(`  ✗ ${name}: ${error.message}`); failed++; }
}

test('inventory entry is normalized and additive', () => {
  let state = createState();
  state = upsertInventory(state, { name: '  Tomatoes ', quantity: 2, unit: 'cans' });
  state = upsertInventory(state, { name: 'tomatoes', quantity: 1, unit: 'cans' });
  assert.deepStrictEqual(state.inventory, [{ name: 'tomatoes', quantity: 3, unit: 'cans' }]);
});

test('restocking uses the same immutable inventory workflow', () => {
  const state = createState({ inventory: [{ name: 'rice', quantity: 1, unit: 'cup' }] });
  const next = restockInventory(state, { name: 'rice', quantity: 2, unit: 'cup' });
  assert.strictEqual(next.inventory[0].quantity, 3);
  assert.strictEqual(state.inventory[0].quantity, 1);
});

test('suggestions respect dislikes and prioritize pantry coverage', () => {
  let state = createState({ inventory: [{ name: 'chickpeas', quantity: 2, unit: 'cans' }, { name: 'tomatoes', quantity: 1, unit: 'can' }] });
  state = setPreferences(state, { likes: ['vegetarian'], dislikes: ['salmon'] });
  const suggestions = suggestRecipes(state);
  assert.ok(suggestions.every(recipe => recipe.name !== 'Salmon Rice Bowl'));
  assert.strictEqual(suggestions[0].name, 'Chickpea Curry');
});

test('weekly plan contains seven days and grocery list only includes deficits', () => {
  const state = createState({
    inventory: [{ name: 'chickpeas', quantity: 2, unit: 'cans' }, { name: 'tomatoes', quantity: 1, unit: 'can' }],
    plan: [{ day: 'Monday', recipeId: 'chickpea-curry', recipeName: 'Chickpea Curry' }],
  });
  assert.strictEqual(generateWeeklyPlan(state).length, 7);
  assert.deepStrictEqual(generateGroceryList(state), [
    { name: 'curry powder', quantity: 1, unit: 'tbsp' },
    { name: 'onion', quantity: 1, unit: 'each' },
  ]);
});

test('completing a recipe depletes matching inventory and records completion', () => {
  const state = createState({ inventory: [{ name: 'oats', quantity: 1, unit: 'cup' }, { name: 'milk', quantity: 1, unit: 'cup' }] });
  const next = consumeRecipe(state, 'oatmeal');
  assert.strictEqual(next.inventory.find(item => item.name === 'oats').quantity, 0.5);
  assert.deepStrictEqual(next.completed, ['oatmeal']);
  assert.strictEqual(state.inventory[0].quantity, 1);
});

console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
