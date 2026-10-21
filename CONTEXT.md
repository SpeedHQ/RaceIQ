# RaceIQ driver activity

RaceIQ distinguishes the local person using the app from the person driving a car in a game. Personal activity is attributed to its driver, not merely to whichever Online account is signed in.

## Drivers and identity

**Installation user**:
The one local person using this RaceIQ installation. Signing out does not change that person or remove their local activity; multiple local users and account switching are not supported.
_Avoid_: Selected profile, currently authenticated user

**Online account**:
A driver's Discord-linked RaceIQ Online identity. Authentication permits remote actions but does not change ownership of previously recorded activity.
_Avoid_: Active in-game driver

**In-game driver**:
The person controlling a game vehicle during an interval. The in-game driver can change during a shared-car session without changing the installation user.
_Avoid_: Player car, signed-in driver

**Game identity binding**:
An explicitly confirmed relationship between a local driver and an identity reported by a game. A matching display name alone is not that relationship.
_Avoid_: Discord-name match

**Driver stint**:
An interval during which the same in-game driver controls the car. One shared-car session can contain several driver stints.
_Avoid_: Whole session

**Self attribution**:
Evidence establishes that the installation user drove the interval or the whole lap in question.
_Avoid_: Recorded on my PC

**Other attribution**:
Evidence establishes that someone other than the installation user drove the interval. Other is not an invitation to credit that activity to a different Online account automatically.
_Avoid_: Unknown driver

**Unknown attribution**:
Evidence cannot establish who drove the interval. Unknown activity is not credited to the installation user or silently classified as Other.
_Avoid_: Assumed self

**Personal lap**:
A lap driven wholly by its attributed local driver. A mixed-driver or unknown-driver lap is shared-session context, not that driver's personal completed lap.
_Avoid_: Lap completed by my car

## Activity and summaries

**Original activity**:
A particular occurrence of a driver's recorded racing activity, distinct from any copy, import or reprocessed representation. Copies of the same original activity do not create additional personal activity.
_Avoid_: Local database row, recording file copy

**Local dashboard summary**:
Statistics for the installation user's personal local activity, using dashboard metric definitions and period views. Removing local activity can change this summary.
_Avoid_: Account-wide lifetime total

**Online lifetime profile**:
The public all-time aggregate of a driver's uniquely identified activity across devices. Synced contributions survive local deletion; a correction replaces the contribution for the same original activity.
_Avoid_: Latest device snapshot, sum of device totals

**Activity correction**:
A revised interpretation of the same original activity, which can increase or decrease its previously reported statistics without counting the activity again.
_Avoid_: New activity, local deletion

**Ambiguous activity identity**:
The relationship between a recording and an original activity cannot be established well enough to merge it safely across devices. It can remain visible locally without contributing to Online lifetime totals.
_Avoid_: Definitely unique, definitely duplicate

**Session classification**:
The game's distinction between race, practice, qualifying and unclassified activity. An unknown session classification is separate from unknown driver attribution.
_Avoid_: Driver ownership

## Sharing and delivery

**Recording sharing**:
Submission of eligible personal lap recordings for cloud validation and potential public competition. It is separate from sharing aggregate profile statistics or optional setups.
_Avoid_: Profile sync

**Profile sync**:
Automatic synchronization of the authenticated driver's eligible aggregate activity after current policy acceptance. It never transfers a Forza recording or setup, even though Forza statistics may contribute.
_Avoid_: Public lap sharing

**Upload acceptance**:
The remote service has acknowledged receipt of an upload. Acceptance does not establish lap validation or publication.
_Avoid_: Validated, published

**Publication**:
An eligible processed lap is visible in public competition. Stopping future recording sharing does not withdraw previously published laps.
_Avoid_: Uploaded

## Lap provenance and Community access

**Lap GUID**:
The globally unique identity of one original lap, preserved across its copies, imports, downloads and revised representations. It identifies the original; by itself it does not prove ownership or authenticity.
_Avoid_: Local row number, upload request key

**Lap provenance**:
The established relationship between an original lap, its source and its attributed driver. Downloading or copying a lap does not make the recipient its original driver.
_Avoid_: Claimed author label

**Community access**:
Eligibility to use the in-app Online lap times and replay integration as a signed-in participant with current policy acceptance and confirmed public lap sharing. Profile-statistics synchronization alone is not that participation.
_Avoid_: Any logged-in user, already published a lap

**Open Replay**:
Opening the exact selected community lap in local replay while preserving its original identity and driver attribution. It is not recording new personal activity or reauthoring the lap.
_Avoid_: New personal lap, generic leaderboard link

**Community validation**:
Best-effort checking and moderation of submitted laps and related results. A validated status does not guarantee accuracy, authenticity, correct attribution or freedom from tampering.
_Avoid_: Anti-cheat certificate, guaranteed authentic
