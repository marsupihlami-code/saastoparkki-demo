'use strict';

const byId = id => document.getElementById(id);
const map = L.map('map', {zoomControl: false}).setView([60.451452, 22.265599], 15);
L.control.zoom({position: 'topright'}).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);
let origin = L.latLng(60.451452, 22.265599);
const originMarker = L.circleMarker(origin, {radius: 8, color: '#fff', weight: 2, fillColor: '#145ed4', fillOpacity: 1}).addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const candidates = Promise.all(['places-city.json', 'places-osm.json'].map(file => fetch(file).then(response => {
  if (!response.ok) throw new Error('Aineistovirhe');
  return response.json();
}))).then(groups => groups.flat()).catch(() => null);
let ranked = [];
let index = 0;
let requestTime = 0;
let busy = false;
const area = L.latLngBounds([60.438, 22.240], [60.466, 22.282]);

function status(message) {
  byId('status').textContent = message;
}

status('Lähtöpisteenä Kauppatorin vieressä oleva Aurakatu. Voit vaihtaa sen kartalta.');
originMarker.bindTooltip('Lähtöpiste', {direction: 'bottom'});

function showSearch() {
  byId('result').hidden = true;
  byId('search').hidden = false;
  routeLayer.clearLayers();
}

function setOrigin(point, message) {
  if (busy) return;
  origin = point;
  originMarker.setLatLng(origin);
  showSearch();
  map.setView(origin, 16);
  status(message);
}

map.on('click', event => setOrigin(event.latlng, 'Lähtöpiste valittu kartalta.'));
byId('location').addEventListener('click', () => {
  if (!navigator.geolocation) {
    status('Sijaintia ei voi käyttää tässä selaimessa. Valitse lähtöpiste kartalta.');
    return;
  }
  status('Haetaan sijaintia…');
  navigator.geolocation.getCurrentPosition(
    position => setOrigin(L.latLng(position.coords.latitude, position.coords.longitude), 'Lähtöpisteenä nykyinen sijaintisi.'),
    () => status('Sijaintia ei saatu. Voit valita lähtöpisteen kartalta.'),
    {enableHighAccuracy: true, timeout: 9000, maximumAge: 30000}
  );
});

function coordinate(point) {
  return [point.lng, point.lat].map(value => value.toFixed(6)).join(',');
}

async function router(path) {
  const remaining = 1100 - (Date.now() - requestTime);
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  requestTime = Date.now();
  const response = await fetch('https://routing.openstreetmap.de/routed-car/' + path, {
    signal: AbortSignal.timeout(11000)
  });
  const result = await response.json();
  if (!response.ok && !result.code) throw new Error('Reititys ei vastannut');
  if (result.code !== 'Ok') throw new Error(result.code || 'Reittiä ei löytynyt');
  return result;
}

function setBusy(value) {
  busy = value;
  for (const id of ['find', 'next', 'back', 'location']) byId(id).disabled = value;
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
  const line = L.geoJSON(route.geometry, {style: {color: '#085aa5', weight: 6, opacity: .9}}).addTo(routeLayer);
  if (place.ring) L.polygon(place.ring, {color: '#005fc0', fillOpacity: .33, weight: 3}).addTo(routeLayer);
  const marker = L.marker(end, {icon: L.divIcon({className: 'pin', html: symbols[place.kind], iconSize: [30, 30]})}).addTo(routeLayer);
  marker.bindTooltip(titles[place.kind]);
  const bounds = line.getBounds().extend(end);
  if (place.ring) bounds.extend(L.latLngBounds(place.ring));
  map.fitBounds(bounds, {padding: [26, 30], maxZoom: 17});

  byId('place').textContent = titles[place.kind];
  const meters = route.distance;
  const distance = meters >= 1000
    ? new Intl.NumberFormat('fi', {maximumFractionDigits: 1}).format(meters / 1000) + ' km'
    : Math.round(meters) + ' m';
  byId('distance').textContent = distance + ' autolla';
  const signs = byId('signs');
  signs.className = 'plates';
  signs.replaceChildren();
  if (place.kind === 'disc') signs.append(plate('P', true), plate('◷ ' + place.note));
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
  byId('search').hidden = true;
  byId('result').hidden = false;
  status('Paikan vapautta ei tiedetä.');
}

async function showNext() {
  while (index < ranked.length) {
    const place = ranked[index++];
    const destination = coordinate(place);
    let response;
    try {
      response = await router('route/v1/driving/' + coordinate(origin) + ';' + destination
        + '?overview=full&geometries=geojson&radiuses=70;35&approaches=unrestricted;curb');
    } catch (error) {
      if (['NoRoute', 'NoSegment'].includes(error.message)) continue;
      index--;
      throw error;
    }
    if (response.routes?.[0]) {
      renderResult(place, response.routes[0]);
      return;
    }
  }
  status('Tässä haussa ei ole enää muita kohteita.');
}

byId('find').addEventListener('click', async () => {
  if (!area.contains(origin)) {
    status('Pilotti kattaa Turun keskustan. Valitse lähtöpiste keskustan kartalta.');
    return;
  }
  setBusy(true);
  status('Etsitään kohteita ja lasketaan ajomatkaa…');
  try {
    const places = await candidates;
    if (!places) throw new Error('Pysäköintiaineistoa ei saatu ladattua.');
    const kind = document.querySelector('input[name="kind"]:checked').value;
    const nearby = places.filter(place => place.kind === kind)
      .map(place => ({...place, air: origin.distanceTo([place.lat, place.lng])}))
      .sort((a, b) => a.air - b.air).slice(0, 16);
    if (!nearby.length) {
      status('Tälle paikkatyypille ei löytynyt kohteita pilottialueelta.');
      return;
    }
    const path = [origin, ...nearby].map(coordinate).join(';');
    const destinations = nearby.map((_, i) => i + 1).join(';');
    const approaches = ['unrestricted', ...nearby.map(() => 'curb')].join(';');
    const response = await router('table/v1/driving/' + path + '?sources=0&destinations=' + destinations
      + '&annotations=distance&approaches=' + approaches);
    const distances = response.distances?.[0] || [];
    ranked = nearby.map((place, i) => ({...place, distance: distances[i]}))
      .filter(place => Number.isFinite(place.distance))
      .sort((a, b) => a.distance - b.distance);
    index = 0;
    if (!ranked.length) {
      status('Näihin kohteisiin ei löytynyt ajoreittiä.');
      return;
    }
    await showNext();
  } catch (error) {
    status(error.message.includes('aineisto') ? error.message : 'Ajoreittiä ei voitu laskea. Yritä uudelleen hetken päästä.');
  } finally {
    setBusy(false);
  }
});

byId('next').addEventListener('click', async () => {
  setBusy(true);
  status('Haetaan seuraavaa paikkaa…');
  try {
    await showNext();
  } catch {
    status('Seuraavaa reittiä ei saatu. Yritä uudelleen.');
  } finally {
    setBusy(false);
  }
});

byId('back').addEventListener('click', () => {
  showSearch();
  status('Valitse paikkatyyppi.');
  document.querySelector('input[name="kind"]:checked').focus();
});
