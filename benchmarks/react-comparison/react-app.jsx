import { useMemo, useReducer } from "react";

const initialState = (rows) => ({ rows, search: "" });

function reducer(state, action) {
  switch (action.type) {
    case "set-label":
      return {
        ...state,
        rows: state.rows.map((row) =>
          row.id === action.id ? { ...row, label: action.value } : row,
        ),
      };
    case "toggle-active":
      return {
        ...state,
        rows: state.rows.map((row) =>
          row.id === action.id ? { ...row, active: !row.active } : row,
        ),
      };
    case "set-rank":
      return {
        ...state,
        rows: state.rows.map((row) =>
          row.id === action.id ? { ...row, rank: action.value } : row,
        ),
      };
    case "set-search":
      return { ...state, search: action.value };
    default:
      throw new Error(`Unknown benchmark action: ${String(action.type)}`);
  }
}

function Row({ row }) {
  return (
    <li className={`bench-row${row.active ? " active" : ""}`} data-row-id={row.id}>
      <input
        type="checkbox"
        tabIndex={-1}
        checked={row.active}
        readOnly
        aria-label={`Active ${row.label}`}
      />
      <span className="bench-label">{row.label}</span>
      <small className="bench-rank">{row.rank}</small>
    </li>
  );
}

export function ReactBenchmarkApp({ initialRows, constants, readyRef }) {
  "use memo";

  const [state, dispatch] = useReducer(reducer, initialRows, initialState);
  const visibleRows = useMemo(() => {
    const needle = state.search.toLowerCase();
    return state.rows
      .filter((row) => row.label.toLowerCase().includes(needle))
      .toSorted((left, right) => left.rank - right.rank || left.id - right.id);
  }, [state.rows, state.search]);
  const activeCount = useMemo(
    () => state.rows.reduce((count, row) => count + Number(row.active), 0),
    [state.rows],
  );

  return (
    <section className="bench-app" ref={readyRef}>
      <header className="bench-controls">
        <output data-bench-count="">{activeCount}</output>
        <button
          type="button"
          data-bench-action="label"
          tabIndex={-1}
          onClick={() =>
            dispatch({
              type: "set-label",
              id: constants.targetId,
              value: constants.changedLabel,
            })
          }
        >
          label
        </button>
        <button
          type="button"
          data-bench-action="label-reset"
          tabIndex={-1}
          onClick={() =>
            dispatch({
              type: "set-label",
              id: constants.targetId,
              value: constants.originalLabel,
            })
          }
        >
          label-reset
        </button>
        <button
          type="button"
          data-bench-action="toggle"
          tabIndex={-1}
          onClick={() =>
            dispatch({ type: "toggle-active", id: constants.targetId })
          }
        >
          toggle
        </button>
        <button
          type="button"
          data-bench-action="promote"
          tabIndex={-1}
          onClick={() =>
            dispatch({
              type: "set-rank",
              id: constants.targetId,
              value: constants.promotedRank,
            })
          }
        >
          promote
        </button>
        <button
          type="button"
          data-bench-action="promote-reset"
          tabIndex={-1}
          onClick={() =>
            dispatch({
              type: "set-rank",
              id: constants.targetId,
              value: constants.originalRank,
            })
          }
        >
          promote-reset
        </button>
        <button
          type="button"
          data-bench-action="filter"
          tabIndex={-1}
          onClick={() =>
            dispatch({ type: "set-search", value: constants.filterValue })
          }
        >
          filter
        </button>
        <button
          type="button"
          data-bench-action="filter-reset"
          tabIndex={-1}
          onClick={() => dispatch({ type: "set-search", value: "" })}
        >
          filter-reset
        </button>
      </header>
      <ul className="bench-rows">
        {visibleRows.map((row) => (
          <Row key={row.id} row={row} />
        ))}
      </ul>
    </section>
  );
}
