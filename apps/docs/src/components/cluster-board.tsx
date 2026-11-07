import { clusterColor, showcase } from "@/lib/showcase";

const VISIBLE_MEMBERS = 3;

export function ClusterBoard() {
  const byNumber = new Map(showcase.items.map((item) => [item.number, item]));
  return (
    <ol className="ig-cluster-board" aria-label={`Root-cause clusters for ${showcase.repo}`}>
      {showcase.clusters.slice(0, 4).map((cluster, index) => {
        const members = cluster.members.flatMap((n) => byNumber.get(n) ?? []);
        return (
          <li
            key={cluster.label}
            className="ig-cluster-card"
            style={{ "--group-color": clusterColor(index) } as React.CSSProperties}
          >
            <div className="ig-cluster-card-head">
              <span className="ig-cluster-dot" aria-hidden="true" />
              <h3>{cluster.label}</h3>
              <span className="ig-cluster-size">{cluster.size}</span>
            </div>
            <p>{cluster.rootCause}</p>
            <div className="ig-cluster-marks" aria-hidden="true">
              {members.map((item) => (
                <svg
                  key={item.number}
                  viewBox="-6 -6 12 12"
                  data-kind={item.kind}
                  aria-hidden="true"
                >
                  {item.kind === "PullRequest" ? (
                    <path d="M0,-5L5,0 0,5 -5,0Z" />
                  ) : (
                    <circle r="4" />
                  )}
                </svg>
              ))}
            </div>
            <ul>
              {members.slice(0, VISIBLE_MEMBERS).map((item) => (
                <li key={item.number}>
                  <a href={item.url} target="_blank" rel="noopener noreferrer">
                    <span className="ig-cluster-num">#{item.number}</span>
                    <span className="ig-cluster-title">{item.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}
