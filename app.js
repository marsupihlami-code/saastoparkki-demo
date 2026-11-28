'use strict';

const byId = id => document.getElementById(id);
const cities = {
  turku: {
    name: 'Turku', inCity: 'Turussa', center: 'Kauppatori', originLabel: 'Aurakatu, Kauppatorin vieressä',
    origin: [60.451452, 22.265599],
    coverage: [[60.35, 22.05], [60.66, 22.48]],
    files: ['places-turku-street.json']
  },
  tampere: {
    name: 'Tampere', inCity: 'Tampereella', center: 'Keskustori', originLabel: 'Keskustori',
    origin: [61.49772, 23.7595],
    coverage: [[61.42, 23.57], [61.64, 23.97]],
    files: ['places-tampere-street.json']
  }
};
const requestedCity = new URLSearchParams(location.search).get('city');
let savedCity;
try {
  savedCity = localStorage.getItem('saastoparkki-city');
} catch {}
const cityKey = requestedCity === 'tampere' || requestedCity === 'turku'
  ? requestedCity : savedCity === 'tampere' ? 'tampere' : 'turku';
const city = cities[cityKey];
try {
  localStorage.setItem('saastoparkki-city', cityKey);
} catch {}
const citySelect = byId('city');
citySelect.value = cityKey;
citySelect.addEventListener('change', () => {
  location.search = new URLSearchParams({city: citySelect.value}).toString();
});
byId('city-subheading').textContent = city.name === 'Tampere' ? 'Tampereen pysäköintihaku' : 'Turun pysäköintihaku';
byId('turku-sources').hidden = cityKey !== 'turku';
byId('tampere-sources').hidden = cityKey !== 'tampere';
byId('center-origin').textContent = 'Valitse ' + city.center;
const version = 'turku-zones-1';
const routePause = 1100;
const routeTimeout = 11000;
const resultBatch = 16;
const sourceRadius = 70;
// Area coordinates are inside the polygon and may be farther from the road.
function destinationRadius(place) {
  return place.ring ? 65 : 35;
}

if (typeof L === 'undefined') {
  byId('status').textContent = 'Karttaa ei voitu ladata. Lataa sivu uudelleen.';
  throw new Error('Leaflet unavailable');
}

const map = L.map('map', {zoomControl: false, zoomSnap: 0.25}).setView(city.origin, 15);
L.control.zoom({position: 'topright', zoomInTitle: 'Lähennä', zoomOutTitle: 'Loitonna'}).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);
let origin = L.latLng(city.origin);
let originLabel = city.originLabel;
let originChosen = false;
const originMarker = L.circleMarker(origin, {radius: 8, color: '#fff', weight: 2, fillColor: '#145ed4', fillOpacity: 1}).addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const routeButton = byId('show-route');
const searchForm = byId('search');
const searchMapToggle = byId('toggle-search-map');
const main = document.querySelector('main');
let routeBounds;
let parkingMarker;

function setSearchMapExpanded(expanded) {
  main.classList.toggle('search-map-expanded', expanded);
  searchForm.hidden = expanded;
  searchMapToggle.setAttribute('aria-expanded', String(!expanded));
  searchMapToggle.setAttribute('aria-label', expanded
    ? 'Pienennä kartta ja näytä hakuvalinnat'
    : 'Laajenna kartta ja piilota hakuvalinnat');
}

searchMapToggle.addEventListener('click', () => {
  setSearchMapExpanded(!searchForm.hidden);
  map.invalidateSize({animate: false});
  searchMapToggle.scrollIntoView({block: 'nearest'});
});

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
let routeCooldownUntil = 0;
let busy = false;
let locating = false;

class DataError extends Error {}
async function loadPlaces() {
  if (!placesPromise) {
    placesPromise = Promise.all(city.files.map(async file => {
      const response = await fetch(file + '?v=' + version);
      if (!response.ok) throw new DataError();
      return response.json();
    })).then(groups => groups.flat().filter(place => !place.restrictedVehicle));
  }
  try {
    return await placesPromise;
  } catch {
    placesPromise = undefined;
    throw new DataError();
  }
}

if (cityKey === 'turku') {
  const pane = 'turkuParking';
  map.createPane(pane).style.zIndex = '350';
  const legend = byId('turku-map-legend');
  function showLegendItem(id) {
    byId(id).hidden = false;
    legend.hidden = false;
  }

  fetch('turku-parking-zones.geojson?v=' + version)
    .then(response => {
      if (!response.ok) throw new DataError();
      return response.json();
    })
    .then(zones => {
      L.geoJSON(zones, {
        pane,
        interactive: false,
        attribution: 'Maksuvyöhykkeet © Turun kaupunki, CC BY 4.0',
        style: {color: '#96511d', weight: 2, dashArray: '5 4', fillColor: '#efad51', fillOpacity: 0.09}
      }).addTo(map).bringToBack();
      showLegendItem('turku-zone-key');
    })
    .catch(() => {});

  loadPlaces()
    .then(places => {
      const spans = places.filter(place => place.kind === 'free' && place.ring);
      for (const place of spans) {
        L.polygon(place.ring, {
          pane, interactive: false, color: '#147da6', weight: 2.5, fillColor: '#75d4fa', fillOpacity: 0.55
        }).addTo(map);
      }
      if (spans.length) showLegendItem('turku-free-key');
    })
    .catch(() => {});
}

function status(message) {
  const id = byId('result').hidden ? 'status' : 'result-status';
  byId(id).textContent = message;
}

status('Valitse lähtöpiste kartalta tai käytä sijaintiasi.');
originMarker.bindTooltip('Lähtöpiste', {direction: 'bottom', permanent: true});

function showSearch() {
  routeButton.hidden = true;
  byId('result').hidden = true;
  byId('condition').hidden = true;
  byId('parking-plate-details').hidden = true;
  main.classList.remove('has-result');
  byId('result-status').textContent = '';
  setSearchMapExpanded(false);
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
byId('result-limits').addEventListener('click', () => byId('info').showModal());
byId('center-origin').addEventListener('click', () => setOrigin(L.latLng(city.origin), city.originLabel));
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
  byId('disc-filter').hidden = !selectedKinds().has('disc');
});
function selectedKinds() {
  return new Set(Array.from(kindField.querySelectorAll('input:checked:not(:disabled)'), input => input.value));
}
function durationLimit(note) {
  const match = (note || '').match(/(\d+)\s*(h|min)\b/i);
  return match ? Number(match[1]) * (match[2].toLowerCase() === 'h' ? 60 : 1) : 0;
}

function coordinate(point) {
  return [point.lng, point.lat].map(value => value.toFixed(6)).join(',');
}

async function router(path) {
  if (Date.now() < routeCooldownUntil) throw new Error('Reitityspalvelun pyyntöraja');
  const remaining = routePause - (Date.now() - requestTime);
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  requestTime = Date.now();
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  let timer;
  try {
    const result = await Promise.race([
      fetch('https://routing.openstreetmap.de/routed-car/' + path, controller ? {signal: controller.signal} : {})
        .then(response => {
          if (response.status === 429 || response.status === 403) {
            const retryAfter = response.headers.get('Retry-After');
            const delay = Number(retryAfter) * 1000 || Date.parse(retryAfter) - Date.now();
            routeCooldownUntil = Date.now() + Math.max(60000, delay || 0);
          }
          if (!response.ok) throw new Error('Reitityspyyntö epäonnistui: ' + response.status);
          return response.json();
        }),
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
  for (const id of ['find', 'back', 'location', 'center-origin', 'disc-min', 'search-distance']) byId(id).disabled = locked;
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

function cityDiscPlate(place) {
  const [weekday, saturday, sunday] = place.schedule.map(time => time.replace(/\s*[-–]\s*/g, '–'));
  const rows = [];
  if (place.minutes) rows.push('◷ ' + (place.minutes % 60 ? place.minutes + ' min' : place.minutes / 60 + ' h'));
  if (weekday) rows.push(weekday);
  if (saturday) rows.push('(' + saturday + ')');
  return {rows, holiday: sunday};
}

function discPlate(place) {
  const {rows, holiday} = place.schedule ? cityDiscPlate(place) : formatDiscPlate(place.note);
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

const titles = {free: 'Aineistossa maksuton', disc: 'Kiekkopaikka', accessible: 'Invapaikka'};
const accessibleSign = '<img class="accessible-sign" src="inva.webp" alt="">';

function renderResult(place, route) {
  routeLayer.clearLayers();
  const end = L.latLng(place.lat, place.lng);
  const line = route ? L.geoJSON(route.geometry, {style: {color: '#085aa5', weight: 6, opacity: .9}}).addTo(routeLayer) : null;
  if (place.ring) L.polygon(place.ring, {color: '#005fc0', fillOpacity: .33, weight: 3}).addTo(routeLayer);
  const marker = L.marker(end, {icon: L.divIcon({className: place.kind === 'accessible' ? 'accessible-pin' : 'pin', html: place.kind === 'accessible' ? accessibleSign : 'P', iconSize: [30, 30]})}).addTo(routeLayer);
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
  const address = place.address || street?.name;
  byId('place').textContent = address || titles[place.kind];
  byId('place-kind').textContent = address ? titles[place.kind] : '';
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
  if (place.kind === 'disc') {
    signs.append(plate('P', true));
    if (!place.schedule || place.minutes || place.schedule.some(Boolean)) signs.append(discPlate(place));
  }
  if ((place.kind === 'accessible' && place.main) || place.source === 'turku-signs') signs.append(plate('P', true));
  if (place.kind === 'accessible') {
    const sign = document.createElement('img');
    sign.className = 'accessible-sign';
    sign.src = 'inva.webp';
    sign.alt = 'Esteettömän pysäköinnin merkki';
    signs.append(sign);
    if (place.minutes || place.schedule?.some(Boolean)) signs.append(discPlate(place));
  }
  signs.hidden = !signs.childElementCount;
  const condition = place.source === 'tampere'
    ? 'Pysäköintiehdot perustuvat Tampereen pysäköintialueaineistoon. Tarkista merkit paikan päällä.'
    : place.kind === 'free' && place.source !== 'turku-signs'
      ? 'OpenStreetMapissa maksuttomaksi merkitty kadunvarsikohde. Tarkista paikalla voimassa olevat pysäköintiehdot.'
      : 'Pysäköintiehto perustuu merkkirekisteriin. Tarkista merkit paikan päällä.';
  const restrictions = place.restrictions || [];
  byId('condition').textContent = [condition, ...restrictions].join(' · ');
  const registeredPlates = place.plates || [];
  const plateDetails = byId('parking-plate-details');
  const plateList = byId('parking-plate-list');
  plateList.replaceChildren(...registeredPlates.map(registered => {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = registered.code + ' ' + registered.label;
    item.append(title);
    if (registered.text) {
      const note = document.createElement('span');
      note.textContent = registered.text;
      item.append(note);
    }
    return item;
  }));
  plateDetails.hidden = !registeredPlates.length;
  byId('result-limits').textContent = registeredPlates.length ? 'Näytä kaikki lisäkilvet' : 'Katso kohteen rajoitukset';
  byId('result-limits').hidden = !registeredPlates.length && !restrictions.length;
  const directions = new URL('https://www.google.com/maps/dir/');
  directions.search = new URLSearchParams({
    api: '1',
    destination: place.lat + ',' + place.lng,
    travelmode: 'driving',
    dir_action: 'navigate'
  });
  byId('directions').href = directions.href;
  byId('apple-maps').href = 'https://maps.apple.com/?dirflg=d&daddr=' + encodeURIComponent(place.lat + ',' + place.lng);
  const streetView = new URL('https://www.google.com/maps/@');
  streetView.search = new URLSearchParams({
    api: '1',
    map_action: 'pano',
    viewpoint: place.lat + ',' + place.lng
  });
  byId('street-view').href = streetView.href;
  setSearchMapExpanded(false);
  searchForm.hidden = true;
  byId('result').hidden = false;
  byId('condition').hidden = false;
  main.classList.add('has-result');
  const notice = route ? (route.distance > 3000 ? 'Kohde on yli 3 km:n ajomatkan päässä. ' : '') : 'Ajoreittiä ei saatavilla. ';
  status(notice + 'Järjestelmä ei tiedä vapaiden paikkojen määrää.');
  byId('place').focus({preventScroll: true});
  showRouteOverview();
}

async function rankBatch(batch) {
  const path = [origin, ...batch].map(coordinate).join(';');
  const destinations = batch.map((_, i) => i + 1).join(';');
  const approaches = ['unrestricted', ...batch.map(() => 'curb')].join(';');
  const radiuses = [sourceRadius, ...batch.map(destinationRadius)].join(';');
  try {
    const response = await router('table/v1/driving/' + path + '?sources=0&destinations=' + destinations
      + '&annotations=distance&approaches=' + approaches + '&radiuses=' + radiuses);
    return batch.map((place, i) => ({...place, rankDistance: response.distances[0][i]}))
      .filter(place => Number.isFinite(place.rankDistance))
      .sort((a, b) => a.rankDistance - b.rankDistance);
  } catch {
    // A failed distance table leaves the original order by straight-line distance.
    return batch;
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
    try {
      const response = await router('route/v1/driving/' + coordinate(origin) + ';' + coordinate(place)
        + '?overview=full&geometries=geojson&steps=true&radiuses=' + sourceRadius + ';' + destinationRadius(place)
        + '&approaches=unrestricted;curb');
      route = response.routes[0] || null;
    } catch {
      // Coordinates remain usable when the route service is unavailable.
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

function searchRadius(value) {
  const text = value.trim();
  if (!text) return Infinity;
  const metres = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(metres) && metres > 0 ? metres : NaN;
}

searchForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || locating) return;
  if (!originChosen) {
    status('Valitse ensin lähtöpiste kartalta tai käytä sijaintiasi.');
    byId('center-origin').focus();
    return;
  }
  const distanceField = byId('search-distance');
  const radius = searchRadius(distanceField.value);
  if (Number.isNaN(radius)) {
    status('Anna hakuetäisyys metreinä, esimerkiksi 500.');
    distanceField.focus();
    return;
  }
  const kinds = selectedKinds();
  if (!kinds.size) {
    status('Valitse vähintään yksi paikkatyyppi.');
    kindField.querySelector('input:not(:disabled)').focus();
    return;
  }
  if (!L.latLngBounds(city.coverage).contains(origin)) {
    status('Olet hakualueen ulkopuolella. Valitse lähtöpiste ' + city.inCity + ' tai vaihda kaupunkia.');
    return;
  }
  busy = true;
  updateControls();
  status('Etsitään kohteita ja lasketaan ajomatkaa…');
  try {
    const places = await loadPlaces();
    const minimum = Number(byId('disc-min').value);
    remainingPlaces = places.filter(place => kinds.has(place.kind)
      && (place.kind !== 'disc' || !minimum || (place.minutes ?? durationLimit(place.note)) >= minimum))
      .map(place => ({...place, air: origin.distanceTo([place.lat, place.lng])}))
      .filter(place => place.air <= radius)
      .sort((a, b) => a.air - b.air);
    ranked = [];
    results = [];
    current = -1;
    exhausted = false;
    if (!remainingPlaces.length) {
      status(Number.isFinite(radius)
        ? 'Valitulla hakuetäisyydellä ei löytynyt sopivia paikkoja.'
        : 'Tälle valinnalle ei löytynyt kohteita aineistosta.');
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
  status('Lähtöpiste: ' + originLabel + '. Valitse paikkatyypit.');
  (kindField.querySelector('input:checked:not(:disabled)') || kindField.querySelector('input:not(:disabled)')).focus();
});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (!navigator.onLine) status('Olet offline-tilassa. Tallennettu aineisto voi olla käytössä, mutta kartta ja ajoreitit tarvitsevat yhteyden.');
window.addEventListener('offline', () => status('Verkkoyhteys katkesi. Ajoreititys on käytettävissä yhteyden palattua.'));

byId('open-info').addEventListener('click', () => byId('info').showModal());
