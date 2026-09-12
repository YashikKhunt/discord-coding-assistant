import {
  InteractionContextType,
  SlashCommandBuilder,
  type SlashCommandOptionsOnlyBuilder,
} from "discord.js";

const MAX_ATTACHMENTS = 3;

function withRepo(builder: SlashCommandBuilder) {
  return builder.addStringOption((option) =>
    option
      .setName("repo")
      .setDescription("Exact GitHub repository, e.g. owner/repo")
      .setRequired(true)
      .setMaxLength(140),
  );
}

function withAttachments(builder: SlashCommandOptionsOnlyBuilder) {
  for (let i = 1; i <= MAX_ATTACHMENTS; i++) {
    builder.addAttachmentOption((option) =>
      option.setName(`attachment${i}`).setDescription("Screenshot or log file"),
    );
  }
  return builder;
}

function base(name: string, description: string) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild);
}

const task = withRepo(base("task", "Implement a change in a repository and open a PR"));
task.addStringOption((option) =>
  option
    .setName("description")
    .setDescription("What should be built or changed")
    .setRequired(true)
    .setMaxLength(6000),
);
task.addStringOption((option) =>
  option.setName("base").setDescription("Base branch (defaults to the repo default branch)"),
);
withAttachments(task);

const bugreport = withRepo(base("bugreport", "Reproduce and fix a bug, then open a PR"));
bugreport.addStringOption((option) =>
  option
    .setName("description")
    .setDescription("What is broken")
    .setRequired(true)
    .setMaxLength(6000),
);
bugreport.addStringOption((option) =>
  option.setName("steps").setDescription("Steps to reproduce").setMaxLength(4000),
);
bugreport.addStringOption((option) =>
  option.setName("expected").setDescription("Expected behaviour").setMaxLength(2000),
);
bugreport.addStringOption((option) =>
  option.setName("issue").setDescription("Related GitHub issue URL or number").setMaxLength(300),
);
withAttachments(bugreport);

const runtest = withRepo(base("runtest", "Run the repository's test suite"));
runtest.addStringOption((option) =>
  option.setName("ref").setDescription("Branch name or #PR number (defaults to default branch)"),
);

const jobIdOption = (builder: SlashCommandOptionsOnlyBuilder) =>
  builder.addStringOption((option) =>
    option.setName("job").setDescription("Job ID, e.g. TASK-0042").setRequired(true),
  );

const status = jobIdOption(base("status", "Show the status of a job"));
const cancel = jobIdOption(base("cancel", "Cancel a queued or running job"));

const jobs = base("jobs", "List recent jobs");
jobs.addIntegerOption((option) =>
  option.setName("limit").setDescription("How many (default 10)").setMinValue(1).setMaxValue(25),
);
jobs.addStringOption((option) =>
  option
    .setName("status")
    .setDescription("Filter by status")
    .addChoices(
      ...["queued", "running", "succeeded", "partial", "failed", "cancelled"].map((value) => ({
        name: value,
        value,
      })),
    ),
);

export const commandDefinitions = [task, bugreport, runtest, status, cancel, jobs];

export const JOB_COMMANDS = new Set(["task", "bugreport", "runtest"]);
