# How Sightline handles people

Naming a face is the one feature here that can do real harm if it is built
carelessly, so this is what it does and does not do, and why.

## What it does

Sightline labels a person **only** when all of the following hold:

1. The identifier returns a name with confidence above your threshold
   (default 0.75).
2. Wikidata says that name is a **human** (`P31 = Q5`).
3. Wikidata records **no date of death** (`P570` absent).
4. The subject has a real **Wikipedia article**.

Fail any one and no name is drawn. The box still appears, labelled `Person`,
and tapping it explains which rule stopped it.

## Why "no date of death" is the accuracy rule, not a moral one

A face-matching system's most common failure is a confident match to a
*resemblance*. Historical figures are heavily over-represented in any image
index — there are more paintings and photographs of Mozart online than of most
living people — so a lookalike drifts towards a historical name far more often
than a wrong living one.

Checking `P570` removes that entire failure class in one query. If the best
match on Earth for the face in front of you is someone who died in 1791, the
honest answer is *"this is not that person"*, and that is what Sightline says.

The same check quietly does a second job: it means the app cannot be used to
put names to people in historical photographs, memorials or graves.

## Why only people with a Wikipedia article

This is the line between **recognising a public figure** and **identifying a
stranger**.

A Wikipedia article is a workable, externally maintained, non-arbitrary test of
"this person is publicly notable and has accepted public identification". It is
not something Sightline decides; it is something the world has already decided.

When Cloud Vision reverse image search is configured, there is a second
mechanism reinforcing the same boundary: a name is only returned when the crop
genuinely matches images **published on the web**. An ordinary person walking
past your camera matches nothing, so nothing is returned. The limitation is
structural rather than a policy that can be toggled off.

## What it will not do

- It will not identify private individuals.
- It will not name anyone who is dead.
- It will not offer a "best guess" below the confidence threshold.
- It does not store, upload or index any face. A crop is sent for one lookup
  and is never written to disk, by the browser or the worker.
- It keeps no history of who has been seen.

## If you are changing this code

The gate lives in `WIKI.person()` in `js/wiki.js` and is applied in
`IDENT.enrich()` in `js/identify.js`. The worker-side prompt in
`worker/index.js` (`promptFor('person')`) instructs the model to refuse
resemblance matches outright.

Those three places are deliberately redundant. Weakening any one of them turns
a public-figure recogniser into a tool for identifying strangers, which is a
different product with a different set of obligations — including, in much of
the world, biometric consent requirements under GDPR Article 9, BIPA and
comparable law.
