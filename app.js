'use strict';

const byId = id => document.getElementById(id);
const defaultOrigin = [60.451452, 22.265599];
const downtown = [[60.438, 22.240], [60.466, 22.282]];
const turkuCoverage = [[60.35, 22.05], [60.66, 22.48]];
const version = 'availability-copy-1';
const routePause = 1100;
const routeTimeout = 11000;
const resultBatch = 16;
const sourceRadius = 70;
const destinationRadius = 35;

if (typeof L === 'undefined') {
  byId('status').textContent = 'Karttaa ei voitu ladata. Lataa sivu uudelleen.';
  throw new Error('Leaflet unavailable');
}

const map = L.map('map', {zoomControl: false, zoomSnap: 0.25}).setView(defaultOrigin, 15);
L.control.zoom({position: 'topright', zoomInTitle: 'Lähennä', zoomOutTitle: 'Loitonna'}).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);
let origin = L.latLng(defaultOrigin);
let originLabel = 'Aurakatu, Kauppatorin vieressä';
let originChosen = false;
const originMarker = L.circleMarker(origin, {radius: 8, color: '#fff', weight: 2, fillColor: '#145ed4', fillOpacity: 1}).addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const routeButton = byId('show-route');
let routeBounds;
let parkingMarker;

function showRouteOverview() {
  routeButton.hidden = true;
  map.invalidateSize({pan: false});
  map.fitBounds(routeBounds, {padding: [26, 30], maxZoom: 17, animate: false});
}

routeButton.addEventListener('click', () => {
  showRouteOverview();
  parkingMarker.getElement().focus({preventScroll: true});
});
let placesPromise;
let ranked = [];
let remainingPlaces = [];
let results = [];
let current = -1;
let exhausted = false;
let requestTime = 0;
let busy = false;
let locating = false;

class DataError extends Error {}
async function loadPlaces() {
  if (!placesPromise) {
    placesPromise = Promise.all(['places-city.json', 'places-osm.json'].map(async file => {
      const response = await fetch(file + '?v=' + version);
      if (!response.ok) throw new DataError();
      return response.json();
    })).then(groups => groups[0].concat(groups[1]));
  }
  try {
    return await placesPromise;
  } catch {
    placesPromise = undefined;
    throw new DataError();
  }
}

function status(message) {
  const id = byId('result').hidden ? 'status' : 'result-status';
  byId(id).textContent = message;
}

status('Valitse lähtöpiste kartalta, käytä sijaintiasi tai valitse Kauppatori.');
originMarker.bindTooltip('Lähtöpiste', {direction: 'bottom', permanent: true});

function showSearch() {
  routeButton.hidden = true;
  byId('result').hidden = true;
  byId('condition').hidden = true;
  document.querySelector('main').classList.remove('has-result');
  byId('result-status').textContent = '';
  byId('search').hidden = false;
  routeLayer.clearLayers();
  map.invalidateSize({pan: false});
}

function setOrigin(point, label) {
  origin = point;
  originLabel = label;
  originChosen = true;
  originMarker.setLatLng(origin);
  map.setView(origin, 16);
  status('Lähtöpiste: ' + label + '.');
}

map.on('click', event => {
  if (!busy && !locating && byId('result').hidden) setOrigin(event.latlng, 'kartalta valittu piste');
});
byId('center-origin').addEventListener('click', () => setOrigin(L.latLng(defaultOrigin), 'Aurakatu, Kauppatorin vieressä'));
byId('location').addEventListener('click', () => {
  if (!navigator.geolocation) {
    status('Sijaintia ei voi käyttää tässä selaimessa. Valitse lähtöpiste kartalta.');
    return;
  }
  locating = true;
  updateControls();
  status('Haetaan sijaintia…');
  let resolved = false;
  function finish(position) {
    if (resolved) return;
    resolved = true;
    clearTimeout(timer);
    locating = false;
    updateControls();
    if (position) {
      setOrigin(L.latLng(position.coords.latitude, position.coords.longitude), 'nykyinen sijaintisi');
    } else {
      status('Sijaintia ei saatu. Yritä uudelleen tai valitse lähtöpiste kartalta.');
    }
  }
  const timer = setTimeout(() => finish(null), 12000);
  navigator.geolocation.getCurrentPosition(finish, () => finish(null),
    {enableHighAccuracy: true, timeout: 9000, maximumAge: 30000});
});

const kindField = document.querySelector('fieldset');
kindField.addEventListener('change', () => {
  for (const card of kindField.querySelectorAll('label')) {
    card.classList.toggle('selected', card.querySelector('input').checked);
  }
  byId('disc-filter').hidden = selectedKind() !== 'disc';
});
function selectedKind() {
  return kindField.querySelector('input:checked').value;
}
function durationLimit(note) {
  const match = (note || '').match(/(\d+)\s*(h|min)\b/i);
  return match ? Number(match[1]) * (match[2].toLowerCase() === 'h' ? 60 : 1) : 0;
}

function coordinate(point) {
  return [point.lng, point.lat].map(value => value.toFixed(6)).join(',');
}

async function router(path) {
  const remaining = routePause - (Date.now() - requestTime);
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  requestTime = Date.now();
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  let timer;
  try {
    const result = await Promise.race([
      fetch('https://routing.openstreetmap.de/routed-car/' + path, controller ? {signal: controller.signal} : {})
        .then(response => response.json()),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (controller) controller.abort();
          reject(new Error('Reititys aikakatkaistiin'));
        }, routeTimeout);
      })
    ]);
    if (result.code !== 'Ok') throw new Error(result.code || 'Reittiä ei löytynyt');
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function updateControls() {
  const locked = busy || locating;
  for (const id of ['find', 'back', 'location', 'center-origin', 'disc-min']) byId(id).disabled = locked;
  byId('previous').disabled = locked || current <= 0;
  byId('next').disabled = locked || exhausted && current >= results.length - 1;
}

function formatDiscPlate(note) {
  const text = (note || '').trim();
  const duration = /\b\d+\s*(h|min)\b/i.exec(text);
  if (!duration) return {rows: [text], holiday: ''};
  const remaining = text.replace(duration[0], '').trim();
  const range = "\\d{1,2}(?:[.:]\\d{2})?\\s*[-–]\\s*\\d{1,2}(?:[.:]\\d{2})?";
  const schedule = new RegExp('^(' + range + ')(?:\\s*\\((' + range + ')\\))?(?:\\s*(' + range + '))?$').exec(remaining);
  const rows = ['◷ ' + duration[0].replace(/\s*(h|min)$/i, ' $1')];
  if (!schedule || schedule[3] && !schedule[2]) {
    if (remaining) rows.push(remaining);
    return {rows, holiday: ''};
  }
  const normalize = hours => hours.replace(/\s*[-–]\s*/, '–');
  rows.push(normalize(schedule[1]));
  if (schedule[2]) rows.push('(' + normalize(schedule[2]) + ')');
  return {rows, holiday: schedule[3] ? normalize(schedule[3]) : ''};
}

function discPlate(note) {
  const {rows, holiday} = formatDiscPlate(note);
  const sign = plate(rows.join('\n'));
  if (holiday) {
    const holidayRow = document.createElement('span');
    holidayRow.className = 'plate-holiday';
    holidayRow.setAttribute('aria-label', 'Sunnuntaisin ja pyhinä ' + holiday);
    holidayRow.textContent = holiday;
    sign.append(holidayRow);
  }
  return sign;
}

function plate(label, main = false) {
  const element = document.createElement('span');
  element.className = main ? 'plate main-sign' : 'plate';
  element.textContent = label;
  return element;
}

const titles = {free: 'Ilmainen pysäköinti', disc: 'Kiekkopaikka', accessible: 'Invapaikka'};
const symbols = {free: 'P', disc: 'P', accessible: '♿'};

function renderResult(place, route) {
  routeLayer.clearLayers();
  const end = L.latLng(place.lat, place.lng);
  const line = route ? L.geoJSON(route.geometry, {style: {color: '#085aa5', weight: 6, opacity: .9}}).addTo(routeLayer) : null;
  if (place.ring) L.polygon(place.ring, {color: '#005fc0', fillOpacity: .33, weight: 3}).addTo(routeLayer);
  const marker = L.marker(end, {icon: L.divIcon({className: 'pin', html: symbols[place.kind], iconSize: [30, 30]})}).addTo(routeLayer);
  parkingMarker = marker;
  marker.bindTooltip(titles[place.kind]);
  const pin = marker.getElement();
  pin.setAttribute('role', 'button');
  pin.setAttribute('aria-label', 'Zoomaa pysäköintipaikkaan');
  function focusParking(event) {
    event.preventDefault();
    event.stopPropagation();
    map.setView(end, map.getMaxZoom(), {animate: false});
    routeButton.hidden = false;
    if (event.type === 'keydown') routeButton.focus({preventScroll: true});
  }
  pin.addEventListener('click', focusParking);
  pin.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') focusParking(event);
  });
  routeBounds = L.latLngBounds([origin, end]);
  if (line) routeBounds.extend(line.getBounds());
  if (place.ring) routeBounds.extend(L.latLngBounds(place.ring));

  const steps = route ? route.legs.reduce((all, leg) => all.concat(leg.steps || []), []) : [];
  const street = steps.slice().reverse().find(step => step.name);
  byId('place').textContent = street ? street.name : titles[place.kind];
  byId('place-kind').textContent = street ? titles[place.kind] : '';
  const meters = route ? route.distance : place.air;
  const distance = meters >= 1000
    ? new Intl.NumberFormat('fi', {maximumFractionDigits: 1}).format(meters / 1000) + ' km'
    : Math.round(meters) + ' m';
  const mode = route ? ' autolla · noin ' + Math.max(1, Math.round(route.duration / 60)) + ' min' : ' linnuntietä';
  byId('distance').textContent = distance + mode;
  byId('result-origin').textContent = 'Lähtöpiste: ' + originLabel;
  byId('position').textContent = 'Kohde ' + (current + 1);
  const signs = byId('signs');
  signs.className = 'plates';
  signs.replaceChildren();
  if (place.kind === 'disc') signs.append(plate('P', true), discPlate(place.note));
  if (place.kind === 'accessible' && place.main) signs.append(plate('P', true));
  if (place.kind === 'accessible') signs.append(plate('♿'));
  signs.hidden = !signs.childElementCount;
  byId('condition').textContent = place.kind === 'free'
    ? 'OpenStreetMapissa maksuttomaksi merkitty alue. Tarkista ehdot paikan päällä.'
    : 'Pysäköintiehto perustuu merkkirekisteriin. Tarkista merkit paikan päällä.';
  const directions = new URL('https://www.google.com/maps/dir/');
  directions.search = new URLSearchParams({
    api: '1',
    destination: place.lat + ',' + place.lng,
    travelmode: 'driving',
    dir_action: 'navigate'
  });
  byId('directions').href = directions.href;
  byId('apple-maps').href = 'https://maps.apple.com/?dirflg=d&daddr=' + encodeURIComponent(place.lat + ',' + place.lng);
  byId('search').hidden = true;
  byId('result').hidden = false;
  byId('condition').hidden = false;
  document.querySelector('main').classList.add('has-result');
  const notice = route ? (route.distance > 3000 ? 'Kohde on yli 3 km:n ajomatkan päässä. ' : '') : 'Ajoreittiä ei saatavilla. ';
  status(notice + 'Järjestelmä ei tiedä vapaiden paikkojen määrää.');
  byId('place').focus({preventScroll: true});
  showRouteOverview();
}

async function rankBatch(batch) {
  const path = [origin, ...batch].map(coordinate).join(';');
  const destinations = batch.map((_, i) => i + 1).join(';');
  const approaches = ['unrestricted', ...batch.map(() => 'curb')].join(';');
  const radiuses = [sourceRadius, ...batch.map(() => destinationRadius)].join(';');
  try {
    const response = await router('table/v1/driving/' + path + '?sources=0&destinations=' + destinations
      + '&annotations=distance&approaches=' + approaches + '&radiuses=' + radiuses);
    return batch.map((place, i) => ({...place, rankDistance: response.distances[0][i]}))
      .filter(place => Number.isFinite(place.rankDistance))
      .sort((a, b) => a.rankDistance - b.rankDistance);
  } catch {
    return batch.map(place => ({...place, fallback: true}));
  }
}

async function showNext() {
  if (current + 1 < results.length) {
    const saved = results[++current];
    renderResult(saved.place, saved.route);
    return;
  }
  while (ranked.length || remainingPlaces.length) {
    if (!ranked.length) ranked = await rankBatch(remainingPlaces.splice(0, resultBatch));
    if (!ranked.length) continue;
    const place = ranked.shift();
    let route = null;
    if (!place.fallback) {
      try {
        const response = await router('route/v1/driving/' + coordinate(origin) + ';' + coordinate(place)
          + '?overview=full&geometries=geojson&steps=true&radiuses=' + sourceRadius + ';' + destinationRadius
          + '&approaches=unrestricted;curb');
        route = response.routes[0] || null;
      } catch {
        // Coordinates remain usable when the route service is unavailable.
      }
    }
    results.push({place, route});
    current++;
    exhausted = !ranked.length && !remainingPlaces.length;
    renderResult(place, route);
    if (exhausted) status((route ? '' : 'Ajoreittiä ei saatavilla. ') + 'Viimeinen kohde. Järjestelmä ei tiedä vapaiden paikkojen määrää.');
    return;
  }
  exhausted = true;
  status('Tässä haussa ei ole enempää reititettäviä kohteita.');
}

byId('find').addEventListener('click', async () => {
  if (busy || locating) return;
  if (!originChosen) {
    status('Valitse ensin lähtöpiste kartalta, käytä sijaintiasi tai valitse Kauppatori.');
    byId('center-origin').focus();
    return;
  }
  const kind = selectedKind();
  if (!L.latLngBounds(turkuCoverage).contains(origin)) {
    status('Pysäköintihaku on käytössä Turussa. Valitse hakukohta Turusta kartalla tai käytä Kauppatoria.');
    return;
  }
  if (kind === 'free' && !L.latLngBounds(downtown).contains(origin)) {
    status('Maksuttomien alueiden aineisto kattaa Turun keskustan. Valitse hakukohta keskustasta tai vaihda kiekko- tai invapaikkahakuun.');
    return;
  }
  busy = true;
  updateControls();
  status('Etsitään kohteita ja lasketaan ajomatkaa…');
  try {
    const places = await loadPlaces();
    const minimum = kind === 'disc' ? Number(byId('disc-min').value) : 0;
    remainingPlaces = places.filter(place => place.kind === kind && (!minimum || durationLimit(place.note) >= minimum))
      .map(place => ({...place, air: origin.distanceTo([place.lat, place.lng])}))
      .sort((a, b) => a.air - b.air);
    ranked = [];
    results = [];
    current = -1;
    exhausted = false;
    if (!remainingPlaces.length) {
      status('Tälle valinnalle ei löytynyt kohteita aineistosta.');
      return;
    }
    await showNext();
  } catch (error) {
    status(error instanceof DataError ? 'Pysäköintiaineistoa ei saatu ladattua. Yritä uudelleen.' : 'Hakua ei voitu suorittaa. Yritä uudelleen.');
  } finally {
    busy = false;
    updateControls();
  }
});

byId('next').addEventListener('click', async () => {
  busy = true;
  updateControls();
  status('Haetaan seuraavaa paikkaa…');
  try {
    await showNext();
  } finally {
    busy = false;
    updateControls();
  }
});
byId('previous').addEventListener('click', () => {
  const saved = results[--current];
  renderResult(saved.place, saved.route);
  updateControls();
});
byId('back').addEventListener('click', () => {
  showSearch();
  status('Lähtöpiste: ' + originLabel + '. Valitse paikkatyyppi.');
  kindField.querySelector('input:checked').focus();
});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (!navigator.onLine) status('Olet offline-tilassa. Tallennettu aineisto voi olla käytössä, mutta kartta ja ajoreitit tarvitsevat yhteyden.');
window.addEventListener('offline', () => status('Verkkoyhteys katkesi. Ajoreititys on käytettävissä yhteyden palattua.'));

byId('open-info').addEventListener('click', () => byId('info').showModal());
