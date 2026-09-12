/* Sightline - following the road, not the bearing.

   An arrow that points straight at the destination points through walls.
   The owner's fix is the right one: point along the ROAD you are meant to
   walk down, round its curve, to the end of it - and when you get there,
   point along the next one.

   Everything needed is already on the device. ROADS holds OpenStreetMap
   ways as polylines, and a polyline network is a graph: the points are
   nodes, the runs between them are edges, and ways that share a point are
   joined. So this builds that graph, snaps you and your destination onto
   it, and walks the cheapest path across it.

   No routing service, no key, no request. The graph is built from tiles
   already cached, which means it works with no signal on a street you have
   walked down before.                                                     */
'use strict';

var ROUTE = (function () {

  var graph = null;        // { nodes: {key:[lat,lon]}, adj: {key:[{to,cost}]} }
  var builtFrom = 0;       // how many tiles the graph was built from
  var current = null;      // the route in force

  /* Five decimals is about a metre. Two ways that meet at a junction carry
     the same coordinate to that precision, which is what joins them. */
  function key(pt) { return pt[0].toFixed(5) + ',' + pt[1].toFixed(5); }

  function metres(a, b) {
    var R = 6371000, p = Math.PI / 180;
    var dLat = (b[0] - a[0]) * p, dLon = (b[1] - a[1]) * p;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a[0] * p) * Math.cos(b[0] * p) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /* Walking. A motorway is a wall to someone on foot even though it is the
     fastest road on the map, and a footpath is a gift. */
  var WALK = {
    motorway: Infinity, motorway_link: Infinity, trunk: 6, trunk_link: 6,
    primary: 1.4, secondary: 1.2, tertiary: 1.1,
    residential: 1, unclassified: 1, living_street: 0.95, service: 1.05,
    pedestrian: 0.85, footway: 0.85, path: 0.95, cycleway: 0.95, steps: 1.6
  };

  function build() {
    var ways = ROADS.near();
    var nodes = {}, adj = {};
    ways.forEach(function (w) {
      var mult = WALK[w.k];
      if (mult === undefined) mult = 1.2;
      if (!isFinite(mult)) return;               // not walkable at all
      for (var i = 0; i < w.pts.length - 1; i++) {
        var a = w.pts[i], b = w.pts[i + 1];
        var ka = key(a), kb = key(b);
        if (ka === kb) continue;
        nodes[ka] = a; nodes[kb] = b;
        var cost = metres(a, b) * mult;
        (adj[ka] = adj[ka] || []).push({ to: kb, cost: cost, road: w.n || '', kind: w.k });
        (adj[kb] = adj[kb] || []).push({ to: ka, cost: cost, road: w.n || '', kind: w.k });
      }
    });
    graph = { nodes: nodes, adj: adj };
    builtFrom = ROADS.have();
    return graph;
  }

  function ready() {
    if (!graph || builtFrom !== ROADS.have()) build();
    return graph && Object.keys(graph.nodes).length > 1;
  }

  /* The nearest point of the network to a position. */
  function snap(pt) {
    if (!ready()) return null;
    var best = null, bd = Infinity;
    var keys = Object.keys(graph.nodes);
    for (var i = 0; i < keys.length; i++) {
      var d = metres(pt, graph.nodes[keys[i]]);
      if (d < bd) { bd = d; best = keys[i]; }
    }
    /* Too far from any road and this is not a walk, it is a field. */
    return (best && bd < 250) ? { key: best, dist: bd } : null;
  }

  /* Dijkstra. A* would want a heap to be worth the trouble, and a few
     thousand nodes of one neighbourhood is small enough that the simple
     one answers in a few milliseconds. */
  function path(fromKey, toKey) {
    var dist = {}, prev = {}, done = {};
    dist[fromKey] = 0;
    var queue = [fromKey];

    while (queue.length) {
      /* Cheapest unvisited. */
      var bi = 0;
      for (var i = 1; i < queue.length; i++) if (dist[queue[i]] < dist[queue[bi]]) bi = i;
      var at = queue.splice(bi, 1)[0];
      if (done[at]) continue;
      done[at] = 1;
      if (at === toKey) break;

      var edges = graph.adj[at] || [];
      for (var e = 0; e < edges.length; e++) {
        var n = edges[e].to;
        if (done[n]) continue;
        var alt = dist[at] + edges[e].cost;
        if (dist[n] === undefined || alt < dist[n]) {
          dist[n] = alt;
          prev[n] = { from: at, road: edges[e].road, kind: edges[e].kind };
          queue.push(n);
        }
      }
    }

    if (dist[toKey] === undefined) return null;
    var out = [], step = toKey;
    while (step) {
      out.unshift({ key: step, road: prev[step] ? prev[step].road : '', kind: prev[step] ? prev[step].kind : '' });
      step = prev[step] ? prev[step].from : null;
    }
    return out;
  }

  /* A route is the path broken into LEGS - a run along one named road. That
     is what the arrows follow: the whole of the road you are on, curve and
     all, and then the next one. */
  /* A route is the path broken into LEGS - a run along one named road. That
     is what the arrows follow: the whole of the road you are on, curve and
     all, and then the next one.

     The grouping is over EDGES, not nodes. A node has no road name of its
     own - it is a point where roads meet - and the first version compared a
     node's name against a leg's, which are two different things, so every
     single step became its own leg and every road was twenty metres long. */
  function legs(steps) {
    var out = [], cur = null;
    for (var i = 1; i < steps.length; i++) {
      var s = steps[i];                       // carries the edge that reached it
      var k = s.road || s.kind || '';
      if (!cur || k !== cur.key) {
        cur = { key: k, name: s.road || '', kind: s.kind || '',
                pts: [graph.nodes[steps[i - 1].key]] };
        out.push(cur);
      }
      cur.pts.push(graph.nodes[s.key]);
    }
    return out.filter(function (l) { return l.pts.length > 1; }).map(function (l) {
      l.metres = 0;
      for (var j = 1; j < l.pts.length; j++) l.metres += metres(l.pts[j - 1], l.pts[j]);
      return l;
    });
  }

  function plan(from, to) {
    if (!ready()) return null;
    var a = snap(from), b = snap(to);
    if (!a || !b) return null;
    if (a.key === b.key) return null;
    var steps = path(a.key, b.key);
    if (!steps || steps.length < 2) return null;
    var ls = legs(steps);
    if (!ls.length) return null;
    var total = 0;
    ls.forEach(function (l) { total += l.metres; });
    current = { legs: ls, metres: Math.round(total), at: Date.now(), leg: 0,
                offRoad: Math.round(a.dist) };
    return current;
  }

  /* WHERE AM I ON IT, AND WHAT AM I FOLLOWING NOW?

     The leg in force is the one whose line you are nearest to. When the end
     of it is behind you, the next leg takes over - which is the
     recalibration the owner asked for, and it happens by measurement rather
     than by a timer. */
  function follow(pos) {
    if (!current) return null;
    var best = 0, bd = Infinity, bAt = 0;
    for (var i = 0; i < current.legs.length; i++) {
      var l = current.legs[i];
      for (var j = 1; j < l.pts.length; j++) {
        var d = pointToSegment(pos, l.pts[j - 1], l.pts[j]);
        if (d.dist < bd) { bd = d.dist; best = i; bAt = j - 1 + d.t; }
      }
    }
    /* THE RECALIBRATION.

       A junction belongs to the leg that ends there AND the leg that starts
       there, and the nearest-segment test hands the tie to the earlier one -
       so standing on the corner kept pointing you down the road you had just
       finished walking. When there is nothing left of a leg, the next one is
       what you are following. */
    function lineFrom(i, at) {
      var l = current.legs[i];
      var out = [];
      var idx = Math.floor(at);
      var t = at - idx;
      if (idx < l.pts.length - 1) {
        out.push(lerpPt(l.pts[idx], l.pts[idx + 1], t));
        for (var k = idx + 1; k < l.pts.length; k++) out.push(l.pts[k]);
      } else {
        out.push(l.pts[l.pts.length - 1]);
      }
      var m2 = 0;
      for (var j = 1; j < out.length; j++) m2 += metres(out[j - 1], out[j]);
      return { pts: out, left: m2 };
    }

    var line = lineFrom(best, bAt);
    if (line.left < 4 && best + 1 < current.legs.length) {
      best += 1; bAt = 0;
      line = lineFrom(best, 0);
    }

    current.leg = best;
    var leg = current.legs[best];
    var ahead = line.pts;
    var left = line.left;

    /* Within fifteen metres of the end, start showing the next road: a turn
       is easier to take before you are standing in it. */
    var next = null;
    if (left < 15 && best + 1 < current.legs.length) next = current.legs[best + 1];

    var remaining = left;
    for (var n2 = best + 1; n2 < current.legs.length; n2++) remaining += current.legs[n2].metres;

    return {
      leg: leg, ahead: ahead, legLeft: Math.round(left),
      offRoute: Math.round(bd), next: next,
      remaining: Math.round(remaining),
      arrived: best === current.legs.length - 1 && left < 12,
      turn: next ? turnOf(ahead, next.pts) : ''
    };
  }

  /* Which way the next road goes, relative to this one. */
  function turnOf(ahead, nextPts) {
    if (ahead.length < 2 || nextPts.length < 2) return '';
    var b1 = bearing(ahead[ahead.length - 2], ahead[ahead.length - 1]);
    var b2 = bearing(nextPts[0], nextPts[1]);
    var d = ((b2 - b1) + 540) % 360 - 180;
    if (Math.abs(d) < 25) return 'straight on';
    if (Math.abs(d) > 150) return 'back';
    return d > 0 ? 'right' : 'left';
  }

  function bearing(a, b) {
    var p = Math.PI / 180;
    var y = Math.sin((b[1] - a[1]) * p) * Math.cos(b[0] * p);
    var x = Math.cos(a[0] * p) * Math.sin(b[0] * p) -
            Math.sin(a[0] * p) * Math.cos(b[0] * p) * Math.cos((b[1] - a[1]) * p);
    return (Math.atan2(y, x) / p + 360) % 360;
  }

  function lerpPt(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

  /* Distance from a point to a segment, and how far along it the nearest
     point lies. Flat-earth is fine over a street. */
  function pointToSegment(p, a, b) {
    var latScale = 111320;
    var lonScale = 111320 * Math.cos(p[0] * Math.PI / 180);
    var px = (p[1] - a[1]) * lonScale, py = (p[0] - a[0]) * latScale;
    var bx = (b[1] - a[1]) * lonScale, by = (b[0] - a[0]) * latScale;
    var len2 = bx * bx + by * by;
    var t = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
    var dx = px - bx * t, dy = py - by * t;
    return { dist: Math.sqrt(dx * dx + dy * dy), t: t };
  }

  function clear() { current = null; }
  function get() { return current; }

  return { plan: plan, follow: follow, clear: clear, get: get, ready: ready,
           snap: snap, metres: metres, bearing: bearing, _build: build,
           _graph: function () { return graph; } };
})();
