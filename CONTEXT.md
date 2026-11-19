# issue-graph

issue-graph reads how issues and pull requests connect in a tracker and reports what it read and what it could not.

## Language

**Provider**:
A tracker issue-graph reads from: GitHub, Linear, Jira, GitLab, YouTrack.
_Avoid_: source, backend, integration

**Work provider**:
A provider other than GitHub, read one neighborhood at a time into work nodes. It follows only the relationships the tracker stores.

**Authority**:
The tracker instance that names a node: a Jira site, a GitLab host, a YouTrack base URL, or a Linear workspace. Two nodes with the same identifier on different authorities are different nodes.
_Avoid_: instance, server, tenant

**Seed**:
The issue or merge request a run starts from.

**Neighborhood**:
The nodes reachable from the seed within the requested depth. References into another project are read one hop and not followed.

**Node**:
One issue or pull request in a run. A node is either read or unavailable.

**Unavailable node**:
A node whose read failed. It stays in the report with an error code instead of disappearing.

**Coverage**:
What a run did not read in full, sorted into buckets: failed, partial, capped out, hub, and depth boundary.

**Partial node**:
A read node with at least one connection listing that was cut short, such as a page limit or a failed sub-read.

**Hub**:
A non-seed node with more links than the hub threshold. It is read but its links are not followed.

**Depth boundary**:
A read node whose links lead past the requested depth or out of the seed's project. It is the requested scope, not a gap, so it does not make a run incomplete.

**Complete run**:
A run with no failed, partial, capped-out, or hub nodes. It exits 0; any other run exits 1.

**Relation**:
A stored connection between two nodes: blocks, duplicate of, related, parent of, or provider specific. Each keeps its native name and direction.
_Avoid_: link (reserved for remote links), reference

**Remote link**:
A URL attached to a node that points outside the provider. It is reported, never fetched.

## Relationships

- A **Run** starts from one **Seed** on one **Authority** and reads a **Neighborhood**.
- Every **Node** in a run is either read or an **Unavailable node**; a read node can also be a **Partial node**, a **Hub**, or a **Depth boundary**.
- A **Complete run** has an empty failed, partial, capped-out, and hub **Coverage** bucket.

## Flagged ambiguities

- "Site" (Jira) and "host" (GitLab) both mean **Authority**; keep the provider word in flags and messages, use **Authority** in shared code.
