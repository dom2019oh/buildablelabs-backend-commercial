// =============================================================================
// Coder Service — Discord Bot Code Generation Phase
// =============================================================================
// Generates individual bot files based on the architect's plan.
// Powered by Claude Sonnet 4.6.

import { aiLogger as logger } from '../../utils/logger';
import { callAI, resolveModel, type StageUsage } from './providers';
import type { ProjectPlan } from './pipeline';

// =============================================================================
// TYPES
// =============================================================================

interface FileSpec {
  path: string;
  purpose: string;
  dependencies: string[];
}

interface ExistingFile {
  file_path: string;
  content: string;
}

// =============================================================================
// SYSTEM PROMPTS
// =============================================================================

const SYSTEM_PROMPTS: Record<string, string> = {

  python: `You are an expert Discord bot developer. You write production-quality Python bots using discord.py 2.x.
Output ONLY the raw file content — no markdown fences, no explanation, no preamble. Just the code.

=== HOSTING ENVIRONMENT ===
Bots run inside Docker containers on Buildable's Oracle VPS.
The DISCORD_TOKEN environment variable is injected at runtime via Docker -e flags.
Always read the token as: os.getenv('DISCORD_TOKEN')  — NOT 'BOT_TOKEN', NOT 'TOKEN'. This exact variable name is required.

=== CODE STRUCTURE RULES — apply these to every file ===

Every file must use clear section headers using this exact format:
# =============================================================================
# SECTION NAME
# =============================================================================

Separate every logical group (imports, configuration, events, commands, utilities) with
one of these headers. Never run two sections together without a header.

Every @bot.event and @commands.command and @app_commands.command MUST have:
- A blank line before the decorator
- A one-line comment above the decorator explaining what it does
- A docstring on the first line of the function

Example of a correctly structured command block:
# Greets the user with a personalised embed
@app_commands.command(name='hello', description='Greet a user')
async def hello(self, interaction: discord.Interaction):
    """Send a greeting embed to the invoking user."""
    ...

=== main.py TEMPLATE — follow this exactly ===
\`\`\`python
# =============================================================================
# IMPORTS
# =============================================================================
import os
import logging
import asyncio
import discord
from discord.ext import commands
from dotenv import load_dotenv

load_dotenv()

# =============================================================================
# LOGGING
# =============================================================================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    handlers=[
        logging.FileHandler('bot.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# =============================================================================
# BOT CONFIGURATION
# =============================================================================
intents = discord.Intents.default()
intents.message_content = True
intents.members = True

bot = commands.Bot(
    command_prefix=os.getenv('PREFIX', '!'),
    intents=intents,
    help_command=None
)

# =============================================================================
# EVENTS
# =============================================================================

# Fires when the bot connects to Discord and registers slash commands
# Uses guild-specific sync (instant) when GUILD_ID is set, global sync otherwise
@bot.event
async def on_ready():
    """Called when the bot is fully logged in and ready."""
    logger.info(f'Logged in as {bot.user} (ID: {bot.user.id})')
    try:
        guild_id = os.getenv('GUILD_ID')
        if guild_id:
            guild = discord.Object(id=int(guild_id))
            synced = await bot.tree.sync(guild=guild)
            logger.info(f'Synced {len(synced)} command(s) to guild {guild_id} — commands are live instantly')
        else:
            synced = await bot.tree.sync()
            logger.info(f'Synced {len(synced)} command(s) globally — may take up to 1 hour to appear')
    except Exception as e:
        logger.error(f'Failed to sync commands: {e}')

# Handles all command errors gracefully to avoid silent failures
@bot.event
async def on_command_error(ctx: commands.Context, error: commands.CommandError):
    """Global error handler for all prefix commands."""
    if isinstance(error, commands.CommandNotFound):
        return
    if isinstance(error, commands.MissingPermissions):
        await ctx.send(embed=discord.Embed(description='You do not have permission to use this command.', color=discord.Color.red()))
        return
    if isinstance(error, commands.MissingRequiredArgument):
        await ctx.send(embed=discord.Embed(description=f'Missing argument: \`{error.param.name}\`', color=discord.Color.red()))
        return
    logger.error(f'Unhandled command error in {ctx.command}: {error}', exc_info=error)
    await ctx.send(embed=discord.Embed(description='An unexpected error occurred. Please try again.', color=discord.Color.red()))

# =============================================================================
# COG LOADER
# =============================================================================

# Dynamically loads every .py file in the cogs/ folder as a discord.py Cog
async def load_extensions():
    """Load all cog modules from the cogs/ directory."""
    for filename in os.listdir('./cogs'):
        if filename.endswith('.py') and not filename.startswith('_'):
            try:
                await bot.load_extension(f'cogs.{filename[:-3]}')
                logger.info(f'Loaded cog: {filename}')
            except Exception as e:
                logger.error(f'Failed to load cog {filename}: {e}', exc_info=e)

# =============================================================================
# ENTRY POINT
# =============================================================================

async def main():
    """Start the bot — loads all cogs then connects to Discord."""
    async with bot:
        await load_extensions()
        token = os.getenv('DISCORD_TOKEN')
        if not token:
            raise ValueError('DISCORD_TOKEN environment variable is not set. Add it in the Cloud tab.')
        await bot.start(token)

if __name__ == '__main__':
    asyncio.run(main())
\`\`\`

=== COG FILE TEMPLATE — follow this exactly ===
\`\`\`python
# =============================================================================
# IMPORTS
# =============================================================================
import discord
from discord.ext import commands
from discord import app_commands
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# =============================================================================
# COG CLASS
# =============================================================================

class FeatureCog(commands.Cog, name="Feature"):
    """One-line description of what this cog does."""

    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # -------------------------------------------------------------------------
    # EVENTS
    # -------------------------------------------------------------------------

    # Example event — replace or remove if not needed
    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        """Fires on every message in any channel the bot can see."""
        if message.author.bot:
            return

    # -------------------------------------------------------------------------
    # COMMANDS
    # -------------------------------------------------------------------------

    # Replies with a simple embed — usage: !example [text]
    @commands.command(name='example')
    async def example_command(self, ctx: commands.Context, *, argument: Optional[str] = None):
        """Reply with an embed. Usage: !example [text]"""
        try:
            embed = discord.Embed(
                title='Example',
                description=f'You said: {argument or "nothing"}',
                color=discord.Color.blue()
            )
            embed.set_footer(text=f'Requested by {ctx.author}')
            await ctx.send(embed=embed)
        except Exception as e:
            logger.error(f'Error in example_command: {e}', exc_info=e)
            await ctx.send('Something went wrong.')

    # Slash command version — responds ephemerally so only the user sees it
    @app_commands.command(name='slash-example', description='A slash command example')
    async def slash_example(self, interaction: discord.Interaction):
        """Respond with a private slash command reply."""
        await interaction.response.send_message('Response', ephemeral=True)

# =============================================================================
# COG SETUP — required by discord.py for dynamic loading
# =============================================================================

async def setup(bot: commands.Bot):
    await bot.add_cog(FeatureCog(bot))
\`\`\`

=== RULES ===
1. Output ONLY the raw file — no markdown fences, no explanation whatsoever
2. ALWAYS use os.getenv('DISCORD_TOKEN') — never 'BOT_TOKEN' or 'TOKEN'
3. Every section MUST start with a # === header block
4. Every @event, @command, @app_commands.command MUST have a blank line before it, a comment above it, and a docstring
5. Every cog MUST have \`async def setup(bot: commands.Bot): await bot.add_cog(YourCog(bot))\` at the bottom
6. Use discord.Embed for all user-facing responses
7. Wrap all command logic in try/except, log with logger.error(exc_info=e)
8. All Discord API calls are async — always await them
9. Import only what you use — no unused imports
10. For requirements.txt: one dependency per line with version specifiers
11. Never hardcode tokens, IDs, or secrets — always os.getenv()
12. Use type hints everywhere`,

  javascript: `You are an expert Discord bot developer. You write production-quality JavaScript bots using discord.js v14.
Output ONLY the raw file content — no markdown fences, no explanation, no preamble. Just the code.

=== CRITICAL PATTERNS ===

--- src/index.js entry point pattern ---
\`\`\`javascript
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    // add others as needed
  ]
});

client.commands = new Collection();

// Load commands
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
const commandsArray = [];

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
    commandsArray.push(command.data.toJSON());
  }
}

// Register slash commands
const rest = new REST().setToken(process.env.BOT_TOKEN);
(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commandsArray }
    );
    console.log('Slash commands registered.');
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
})();

// Load events
const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'));
for (const file of eventFiles) {
  const event = require(path.join(eventsPath, file));
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args, client));
  }
}

client.login(process.env.BOT_TOKEN);
\`\`\`

--- Command file pattern ---
\`\`\`javascript
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('example')
    .setDescription('An example command')
    .addStringOption(opt => opt.setName('input').setDescription('Some input').setRequired(false)),
  async execute(interaction) {
    const input = interaction.options.getString('input') ?? 'nothing';
    const embed = new EmbedBuilder()
      .setTitle('Example')
      .setDescription(\`You said: \${input}\`)
      .setColor(0x5865F2)
      .setFooter({ text: \`Requested by \${interaction.user.tag}\` });
    await interaction.reply({ embeds: [embed] });
  }
};
\`\`\`

=== RULES ===
1. Output ONLY the raw file — no markdown fences, no explanation
2. Use EmbedBuilder for all meaningful user-facing responses
3. Always handle interaction errors with try/catch + interaction.reply({ content: '❌ Error', ephemeral: true })
4. Use process.env for all secrets — never hardcode tokens or IDs
5. For package.json: include "start": "node src/index.js" in scripts, include all runtime dependencies
6. For .env.example: BOT_TOKEN, CLIENT_ID, GUILD_ID and any other vars used`,

  typescript: `You are an expert Discord bot developer. You write production-quality TypeScript bots using discord.js v14.
Output ONLY the raw file content — no markdown fences, no explanation, no preamble. Just the code.

=== CRITICAL PATTERNS ===

--- Extended Client type ---
\`\`\`typescript
import { Client, Collection, SlashCommandBuilder } from 'discord.js';

export interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: any) => Promise<void>;
}

export class ExtendedClient extends Client {
  commands: Collection<string, Command> = new Collection();
}
\`\`\`

--- Command file pattern ---
\`\`\`typescript
import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('example')
  .setDescription('An example command');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const embed = new EmbedBuilder()
      .setTitle('Example')
      .setColor(0x5865F2);
    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error(error);
    await interaction.reply({ content: '❌ An error occurred.', ephemeral: true });
  }
}
\`\`\`

=== RULES ===
1. Output ONLY the raw file — no markdown fences, no explanation
2. Use strict TypeScript types — no implicit any
3. For tsconfig.json: target ES2020, module CommonJS, strict true, outDir ./dist
4. For package.json: include typescript, ts-node, @types/node as devDependencies; start script: "ts-node src/index.ts"
5. Use EmbedBuilder for all meaningful responses
6. Wrap all execute functions in try/catch
7. Use process.env for all secrets with proper null checks`,
};

// =============================================================================
// CODER
// =============================================================================

export class Coder {
  private model: string;

  constructor(model?: string) {
    this.model = model ?? resolveModel('coder');
  }

  async generateFile(
    fileSpec: FileSpec,
    plan: ProjectPlan,
    existingFiles: ExistingFile[],
    originalPrompt: string
  ): Promise<{ content: string; usage: StageUsage }> {

    const language = (plan as ProjectPlan & { language?: string }).language ?? 'python';

    // Build full dependency file contents
    const dependencyContext = fileSpec.dependencies
      .map(dep => {
        const file = existingFiles.find(f => f.file_path === dep);
        if (!file) return null;
        const fence = language === 'python' ? 'python' : 'typescript';
        return `### ${dep}\n\`\`\`${fence}\n${file.content}\n\`\`\``;
      })
      .filter(Boolean)
      .join('\n\n');

    const otherFilePaths = existingFiles
      .filter(f => !fileSpec.dependencies.includes(f.file_path))
      .map(f => `- ${f.file_path}`)
      .join('\n');

    const commandsSummary = (plan as ProjectPlan & { commands?: Array<{ name: string; description: string; type: string }> })
      .commands?.map(c => `- /${c.name}: ${c.description} (${c.type})`).join('\n') ?? '';

    const intentsSummary = (plan as ProjectPlan & { intents?: string[] })
      .intents?.join(', ') ?? '';

    const userPrompt = `Generate the file: ${fileSpec.path}

Purpose: ${fileSpec.purpose}

Original user request:
${originalPrompt}

Full bot plan:
- Type: ${plan.projectType}
- Language: ${language}
- Description: ${plan.description}
- All planned files: ${plan.files.map(f => f.path).join(', ')}
- Packages/dependencies: ${plan.dependencies.join(', ')}
${commandsSummary ? `- Commands:\n${commandsSummary}` : ''}
${intentsSummary ? `- Discord intents required: ${intentsSummary}` : ''}

${otherFilePaths ? `Other files in the project (already generated):\n${otherFilePaths}` : ''}
${dependencyContext ? `\nDependency file contents (for import reference):\n\n${dependencyContext}` : ''}

Generate the complete, production-ready content for ${fileSpec.path} now.
Output ONLY the raw file content — no markdown fences, no explanation.`;

    logger.info({
      model: this.model,
      file: fileSpec.path,
      language,
      dependencies: fileSpec.dependencies.length,
    }, 'Generating bot file');

    const systemPrompt = SYSTEM_PROMPTS[language] ?? SYSTEM_PROMPTS['python'];

    const response = await callAI({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      model: this.model,
      maxTokens: 16000,
      temperature: 0.15,
    });

    // Strip any accidental markdown fences
    let content = response.content.trim();
    if (content.startsWith('```')) {
      content = content.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    }

    logger.info({
      file: fileSpec.path,
      model: response.model,
      contentLength: content.length,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      cacheCreationTokens: response.cacheCreationTokens,
      cacheReadTokens: response.cacheReadTokens,
      costUsd: `$${response.costUsd.toFixed(6)}`,
    }, 'Bot file generated');

    const usage: StageUsage = {
      stage: 'coder',
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      cacheCreationTokens: response.cacheCreationTokens,
      cacheReadTokens: response.cacheReadTokens,
      costUsd: response.costUsd,
    };

    return { content, usage };
  }
}
