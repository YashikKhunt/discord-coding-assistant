import { type FormEvent, useState } from "react";
import { api, type JobType } from "../api.ts";
import { navigate, useTitle } from "../router.tsx";

const TYPES: { type: JobType; blurb: string }[] = [
  { type: "task", blurb: "Implement a change and open a pull request" },
  { type: "bugreport", blurb: "Reproduce and fix a bug, then open a PR" },
  { type: "runtest", blurb: "Run the existing test suite and report" },
];

export function NewJobPage() {
  useTitle("New job");
  const [type, setType] = useState<JobType>("task");
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState("");
  const [expected, setExpected] = useState("");
  const [issue, setIssue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo.trim())) {
      setError("Repository must be exactly owner/repo.");
      return;
    }
    if (type !== "runtest" && !description.trim()) {
      setError(type === "task" ? "Describe the change you want." : "Describe the bug.");
      return;
    }
    setSubmitting(true);
    try {
      const { job } = await api.createJob({
        type,
        repo: repo.trim(),
        ref: type === "runtest" ? ref.trim() || undefined : undefined,
        input:
          type === "runtest"
            ? {}
            : {
                description: description.trim(),
                base: ref.trim() || undefined,
                ...(type === "bugreport"
                  ? {
                      steps: steps.trim() || undefined,
                      expected: expected.trim() || undefined,
                      issue: issue.trim() || undefined,
                    }
                  : {}),
              },
      });
      navigate(`/jobs/${job.shortId}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">same as the Discord commands</p>
          <h1>New job</h1>
        </div>
      </div>

      <form className="form" onSubmit={submit} noValidate>
        <fieldset className="type-cards" aria-label="Job type">
          {TYPES.map((option) => (
            <button
              key={option.type}
              type="button"
              className="type-card"
              aria-pressed={type === option.type}
              onClick={() => setType(option.type)}
            >
              <strong>/{option.type}</strong>
              <span>{option.blurb}</span>
            </button>
          ))}
        </fieldset>

        <div className="row-2">
          <div className="field">
            <label htmlFor="repo">Repository</label>
            <input
              id="repo"
              className="input mono"
              placeholder="YashikKhunt/ewc-rulebook-rag"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="ref">{type === "runtest" ? "Ref" : "Base branch"}</label>
            <input
              id="ref"
              className="input mono"
              placeholder={type === "runtest" ? "main, a branch, or #12" : "default branch"}
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>

        {type !== "runtest" && (
          <div className="field">
            <label htmlFor="description">
              {type === "task" ? "What should change" : "What is broken"}
            </label>
            <textarea
              id="description"
              className="textarea"
              rows={6}
              maxLength={6000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                type === "task"
                  ? "Add pytest unit tests for the pure helper functions in chunker.py"
                  : "Searching for 'Article 12' returns results from the wrong rulebook"
              }
            />
            <span className="hint">
              The agent treats this as the spec. Mention files, constraints and how to verify.
            </span>
          </div>
        )}

        {type === "bugreport" && (
          <>
            <div className="field">
              <label htmlFor="steps">Steps to reproduce</label>
              <textarea
                id="steps"
                className="textarea"
                rows={3}
                value={steps}
                onChange={(e) => setSteps(e.target.value)}
              />
            </div>
            <div className="row-2">
              <div className="field">
                <label htmlFor="expected">Expected behaviour</label>
                <input
                  id="expected"
                  className="input"
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="issue">Linked issue</label>
                <input
                  id="issue"
                  className="input mono"
                  placeholder="#42"
                  value={issue}
                  onChange={(e) => setIssue(e.target.value)}
                />
              </div>
            </div>
          </>
        )}

        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        <div>
          <button type="submit" className="button primary" disabled={submitting}>
            {submitting ? "Queuing…" : `Queue /${type}`}
          </button>
        </div>
      </form>
    </>
  );
}
