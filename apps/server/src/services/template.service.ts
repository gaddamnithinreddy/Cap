import { Daytona, Image } from "@daytonaio/sdk";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";

export async function buildProjectTemplate(projectId: string): Promise<void> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
  });

  let buildLog = "";
  const log = (msg: string) => {
    buildLog += msg + "\n";
    prisma.project
      .update({ where: { id: projectId }, data: { templateBuildLog: buildLog } })
      .catch(() => {});
  };

  try {
    await prisma.project.update({
      where: { id: projectId },
      data: { templateStatus: "BUILDING", templateBuildLog: "" },
    });

    log("Building template...");

    // Build service install commands
    const servicePkgs: string[] = [];
    for (const svc of project.requiredServices) {
      if (svc === "postgres") servicePkgs.push("postgresql", "postgresql-client");
      else if (svc === "redis") servicePkgs.push("redis-server");
      else if (svc === "mysql") servicePkgs.push("mysql-server");
    }

    const allPkgs = ["git", "curl", "xvfb", "x11vnc", "python3-pip", "chromium", ...servicePkgs].join(" ");

    // Daytona snapshot name (stored in the project's template id column).
    const snapshotName = `vendi-${projectId}`;

    if (env.DAYTONA_BUILD_SNAPSHOT === "true") {
      // Bake the dependencies into a dedicated Daytona snapshot — parity with the
      // old E2B template build. The same packages, global npm tools, and /workspace
      // setup are applied on top of node:22-bookworm.
      const image = Image.base("node:22-bookworm").dockerfileCommands([
        `RUN apt-get update && apt-get install -y ${allPkgs} \\`,
        `    && pip3 install websockify --break-system-packages \\`,
        `    && apt-get clean && rm -rf /var/lib/apt/lists/*`,
        `RUN npm install -g bun @openai/codex-sdk`,
        `RUN mkdir -p /workspace && chmod 777 /workspace \\`,
        `    && git config --global --add safe.directory /workspace`,
      ]);

      log("Building image and registering Daytona snapshot...");

      const daytona = new Daytona({
        apiKey: env.DAYTONA_API_KEY,
        apiUrl: env.DAYTONA_SERVER_URL,
        target: env.DAYTONA_TARGET,
      });

      await daytona.snapshot.create(
        { name: snapshotName, image, resources: { cpu: 8, memory: 16 } },
        {
          onLogs: (chunk) => {
            if (chunk) buildLog += chunk;
          },
          timeout: 0,
        }
      );
    } else {
      // Default: session sandboxes provision their dependencies at start-up
      // (apt/npm), so no heavyweight snapshot pre-build is required here.
      log("Dependencies will be provisioned at sandbox start. Skipping snapshot pre-build.");
    }

    log("Template built successfully!");

    await prisma.project.update({
      where: { id: projectId },
      data: {
        e2bTemplateId: snapshotName,
        templateStatus: "READY",
        templateBuildLog: buildLog,
      },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Template build failed:", errorMsg);
    await prisma.project.update({
      where: { id: projectId },
      data: {
        templateStatus: "FAILED",
        templateBuildLog: buildLog + "\n\nERROR: " + errorMsg,
      },
    });
    throw error;
  }
}
