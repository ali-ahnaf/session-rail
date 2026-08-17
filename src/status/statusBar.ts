/**
 * Single left-cluster status-bar item summarizing live sessions and agents.
 */

import * as vscode from 'vscode';

import { walkAgents, type Snapshot } from '../model/types';
import type { RailRegistry } from '../scan/registry';
import { safely } from '../util/log';

const REVEAL_COMMAND = 'workbench.view.extension.sessionRail';

interface ProjectCounts {
  readonly name: string;
  readonly liveSessions: number;
  readonly generatingSessions: number;
  readonly runningAgents: number;
}

export class RailStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;

  constructor(registry: RailRegistry) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = REVEAL_COMMAND;

    this.subscription = registry.onDidChange((snapshot) => {
      safely('RailStatusBar.render', () => this.render(snapshot), undefined);
    });

    // Render once synchronously so the item is correct before the first event.
    safely('RailStatusBar.render(initial)', () => this.render(registry.snapshot()), undefined);
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }

  private render(snapshot: Snapshot): void {
    let liveSessions = 0;
    let generatingSessions = 0;
    let runningAgents = 0;
    const perProject: ProjectCounts[] = [];

    for (const project of snapshot.projects) {
      let projectLive = 0;
      let projectGenerating = 0;
      let projectAgents = 0;

      for (const session of project.sessions) {
        if (session.state === 'exited') {
          continue;
        }
        projectLive++;
        if (session.state === 'generating') {
          projectGenerating++;
        }
        walkAgents(session.agents, (agent) => {
          if (agent.state === 'running') {
            projectAgents++;
          }
        });
      }

      liveSessions += projectLive;
      generatingSessions += projectGenerating;
      runningAgents += projectAgents;

      if (projectLive > 0) {
        perProject.push({
          name: project.name,
          liveSessions: projectLive,
          generatingSessions: projectGenerating,
          runningAgents: projectAgents,
        });
      }
    }

    if (liveSessions === 0) {
      this.item.hide();
      return;
    }

    const headline =
      generatingSessions > 0
        ? `$(loading~spin) ${generatingSessions} generating`
        : `$(circle-filled) ${liveSessions} live`;
    const agentSuffix = runningAgents > 0 ? ` · ${runningAgents} agents` : '';
    this.item.text = `${headline}${agentSuffix}`;
    this.item.tooltip = this.buildTooltip(perProject, liveSessions, generatingSessions, runningAgents);
    this.item.show();
  }

  private buildTooltip(
    perProject: readonly ProjectCounts[],
    liveSessions: number,
    generatingSessions: number,
    runningAgents: number,
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(
      `**Session Rail** — ${liveSessions} live session(s), ${generatingSessions} generating, ${runningAgents} running agent(s)\n\n`,
    );
    if (perProject.length === 0) {
      md.appendMarkdown('_No active projects._');
      return md;
    }
    for (const project of perProject) {
      md.appendMarkdown(
        `- **${project.name}** — ${project.liveSessions} live` +
          (project.generatingSessions > 0 ? `, ${project.generatingSessions} generating` : '') +
          (project.runningAgents > 0 ? `, ${project.runningAgents} agents` : '') +
          '\n',
      );
    }
    return md;
  }
}
