#!/usr/bin/env node
'use strict';

const http = require('http');
const { consumeRecipe, createState, generateGroceryList, generateWeeklyPlan, restockInventory, setPreferences, suggestRecipes } = require('./lib/meal-planner');

const HOST = process.env.MEAL_PLANNER_HOST || '127.0.0.1';
const PORT = Number(process.env.MEAL_PLANNER_PORT || 3460);
let state = createState();

function send(response, status, body, contentType = 'application/json') {
  response.writeHead(status, { 'Content-Type': `${contentType}; charset=utf-8`, 'Cache-Control': 'no-store' });
  response.end(contentType === 'application/json' ? JSON.stringify(body) : body);
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => { body += chunk; if (body.length > 100_000) request.destroy(new Error('Request body too large.')); });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(new Error(`Invalid JSON: ${error.message}`)); }
    });
    request.on('error', reject);
  });
}

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pantry Pilot</title>
<style>
:root{font-family:Inter,system-ui,sans-serif;color:#263238;background:#f7f5ef}*{box-sizing:border-box}body{margin:0}.shell{max-width:1100px;margin:auto;padding:32px 20px 56px}.hero{display:flex;justify-content:space-between;gap:20px;align-items:end;margin-bottom:24px}.eyebrow{color:#bc5b35;font-weight:700;letter-spacing:.12em;text-transform:uppercase;font-size:12px}.hero h1{font-size:42px;line-height:1;margin:8px 0}.hero p{color:#687078;margin:8px 0 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}.card{background:#fff;border:1px solid #e3ded4;border-radius:18px;padding:20px;box-shadow:0 4px 16px #513c1710}.card h2{font-size:18px;margin:0 0 16px}.form{display:flex;gap:8px;flex-wrap:wrap}.form input,.form select{border:1px solid #d8d2c7;border-radius:9px;padding:10px;min-width:0;flex:1}.button{border:0;border-radius:9px;background:#bc5b35;color:white;font-weight:700;padding:10px 14px;cursor:pointer}.button.secondary{background:#eee9df;color:#55483d}.list{display:grid;gap:8px;margin-top:14px}.row{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid #eee9df}.muted{color:#687078;font-size:13px}.pill{background:#f7e6dc;color:#99482b;padding:4px 8px;border-radius:999px;font-size:12px}.empty{color:#8b8f91;font-style:italic}.plan{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}.day{background:#f7f5ef;border-radius:12px;padding:12px}.day strong{display:block;font-size:12px;color:#8b8f91}.day button{background:none;border:0;color:#263238;text-align:left;padding:8px 0;cursor:pointer;font-weight:700}.error{color:#b32d2d;margin-top:12px}
</style></head><body><main class="shell"><div class="hero"><div><div class="eyebrow">Pantry Pilot</div><h1>Cook what you have.</h1><p>A practical weekly plan built around your pantry and preferences.</p></div><button class="button" onclick="buildPlan()">Build my week</button></div>
<div class="grid"><section class="card"><h2>Inventory</h2><form class="form" onsubmit="addItem(event)"><input id="itemName" placeholder="Ingredient" required><input id="itemQty" type="number" min="0.1" step="0.1" placeholder="Qty" required><input id="itemUnit" placeholder="Unit" value="each"><button class="button">Add</button></form><div id="inventory" class="list"></div></section>
<section class="card"><h2>Preferences</h2><p class="muted">Add tags or ingredients separated by commas.</p><form onsubmit="savePreferences(event)"><input id="likes" placeholder="Likes: quick, vegetarian"><input id="dislikes" placeholder="Avoid: salmon, peanuts"><button class="button" style="margin-top:10px">Save preferences</button></form><div id="suggestions" class="list"></div></section>
<section class="card"><h2>Weekly plan</h2><div id="plan" class="plan"></div></section><section class="card"><h2>Grocery list</h2><div id="groceries" class="list"></div></section></div><div id="error" class="error"></div></main>
<script>
const api=async(path,options={})=>{const res=await fetch(path,{headers:{'Content-Type':'application/json'},...options});const data=await res.json();if(!res.ok)throw new Error(data.error||'Request failed');return data};
const csv=value=>value.split(',').map(v=>v.trim()).filter(Boolean);
const escapeHtml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function refresh(){const s=await api('/api/state');document.querySelector('#likes').value=s.preferences.likes.join(', ');document.querySelector('#dislikes').value=s.preferences.dislikes.join(', ');document.querySelector('#inventory').innerHTML=s.inventory.length?s.inventory.map(i=>'<div class="row"><span>'+escapeHtml(i.name)+' <span class="muted">'+i.quantity+' '+escapeHtml(i.unit)+'</span></span><button class="button secondary" onclick="restock(\\''+encodeURIComponent(i.name)+'\\',\\''+encodeURIComponent(i.unit)+'\\')">Restock</button></div>').join(''):'<div class="empty">Your pantry is empty.</div>';document.querySelector('#plan').innerHTML=s.plan.length?s.plan.map(p=>'<div class="day"><strong>'+escapeHtml(p.day)+'</strong><button onclick="complete(\\''+encodeURIComponent(p.recipeId)+'\\')">'+escapeHtml(p.recipeName)+'</button></div>').join(''):'<div class="empty">Build a week to get started.</div>';const g=await api('/api/groceries');document.querySelector('#groceries').innerHTML=g.length?g.map(i=>'<div class="row"><span>'+escapeHtml(i.name)+'</span><strong>'+i.quantity+' '+escapeHtml(i.unit)+'</strong></div>').join(''):'<div class="empty">Nothing to buy for this plan.</div>';const suggestions=await api('/api/suggestions');document.querySelector('#suggestions').innerHTML=suggestions.map(r=>'<div class="row"><span><strong>'+escapeHtml(r.name)+'</strong><br><span class="muted">'+r.pantryMatches+'/'+r.ingredients.length+' ingredients on hand</span></span><span class="pill">'+r.score+' pts</span></div>').join('')};
async function addItem(e){e.preventDefault();await api('/api/inventory',{method:'POST',body:JSON.stringify({name:itemName.value,quantity:itemQty.value,unit:itemUnit.value})});e.target.reset();itemUnit.value='each';refresh().catch(showError)}
async function restock(name,unit){const quantity=prompt('How much would you like to restock?','1');if(quantity===null)return;await api('/api/restock',{method:'POST',body:JSON.stringify({name:decodeURIComponent(name),quantity,unit:decodeURIComponent(unit)})});refresh().catch(showError)}
async function savePreferences(e){e.preventDefault();await api('/api/preferences',{method:'POST',body:JSON.stringify({likes:csv(likes.value),dislikes:csv(dislikes.value)})});refresh().catch(showError)}
async function buildPlan(){await api('/api/plan',{method:'POST'});refresh().catch(showError)}
async function complete(id){await api('/api/consume',{method:'POST',body:JSON.stringify({recipeId:decodeURIComponent(id)})});refresh().catch(showError)}
function showError(e){document.querySelector('#error').textContent=e.message}
refresh().catch(showError);
</script></body></html>`;

function createMealPlannerServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      if (request.method === 'GET' && url.pathname === '/') return send(response, 200, HTML, 'text/html');
      if (request.method === 'GET' && url.pathname === '/api/state') return send(response, 200, state);
      if (request.method === 'GET' && url.pathname === '/api/suggestions') return send(response, 200, suggestRecipes(state));
      if (request.method === 'GET' && url.pathname === '/api/groceries') return send(response, 200, generateGroceryList(state));
      if (request.method === 'POST' && url.pathname === '/api/inventory') { state = restockInventory(state, await parseBody(request)); return send(response, 200, state); }
      if (request.method === 'POST' && url.pathname === '/api/restock') { state = restockInventory(state, await parseBody(request)); return send(response, 200, state); }
      if (request.method === 'POST' && url.pathname === '/api/preferences') { state = setPreferences(state, await parseBody(request)); return send(response, 200, state); }
      if (request.method === 'POST' && url.pathname === '/api/plan') { state = { ...state, plan: generateWeeklyPlan(state) }; return send(response, 200, state.plan); }
      if (request.method === 'POST' && url.pathname === '/api/consume') { state = consumeRecipe(state, (await parseBody(request)).recipeId); return send(response, 200, state); }
      return send(response, 404, { error: 'Not found' });
    } catch (error) {
      return send(response, 400, { error: error.message });
    }
  });
}

if (require.main === module) {
  createMealPlannerServer().listen(PORT, HOST, () => console.log(`Pantry Pilot is running at http://${HOST}:${PORT}`));
}

module.exports = { createMealPlannerServer, parseBody };
