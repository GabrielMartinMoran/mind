import { ArgParser } from './arg-parser';
import type { BrainProvider } from './brain-provider';
import type { Logger } from './logger';
import { style } from 'bun-style';

export const param = (name: string): string => {
    return ArgParser.param(name);
};

const ARG_PARSERS = {
    HELP: new ArgParser(['help|h'], 'Lists all available commands'),
    CREATE_SPACE: new ArgParser(['create|c', param('space'), param('description')], 'Creates a new space'),
    LIST_SPACES: new ArgParser(['list|ls|l'], 'Lists all spaces'),
    READ_SPACE: new ArgParser(['read|r', param('space')], 'Reads a space memories'),
    RENAME_SPACE: new ArgParser(['rename|rn', param('old'), param('new')], 'Renames a space'),
    ADD_TO_SPACE: new ArgParser(['add|a', param('space'), param('value')], 'Adds a memory to a space'),
    REMOVE_FROM_SPACE: new ArgParser(['remove|rm', param('space'), param('index')], 'Removes a memory from a space'),
    DELETE_SPACE: new ArgParser(['delete|d', param('space')], 'Deletes a space'),
    CHANGE_SPACE_DESCRIPTION: new ArgParser(
        ['describe|ds', param('space'), param('description')],
        'Changes a space description'
    ),
    REORDER_SPACE: new ArgParser(
        ['reorder|ro', param('space'), param('fromIndex'), param('toIndex')],
        "Reorders space memories moving a memory from one index to another. When toIndex is 0, the memory it's moved to the top of the space; and when -1, it's moved to the bottom of the space"
    ),
};

export const executeCommand = (args: string[], brainProvider: BrainProvider, logger: Logger) => {
    const { createSpace, saveBrain, getBrain } = brainProvider;
    const { logInfo } = logger;

    const printMemories = (memories: string[]) => {
        for (let i = 0; i < memories.length; i++) {
            logInfo(`   ${style(`${i + 1}.`, ['bold'])} ${memories[i]}`);
        }
    };

    if (args.length === 0) {
        throw new Error('No arguments provided');
    }

    if (ARG_PARSERS.HELP.matches(args)) {
        logInfo(style('💻 Allowed commands:', ['bold', 'black']));
        for (const parser of Object.values(ARG_PARSERS)) {
            logInfo(`   ${parser.getRendered()}`);
        }
        return;
    }

    if (ARG_PARSERS.CREATE_SPACE.matches(args)) {
        const { space, description } = ARG_PARSERS.CREATE_SPACE.getParams(args);
        createSpace(space, description);
        logInfo(style(`✅ Space ${space} created`, ['bold', 'green']));
        return;
    }

    if (ARG_PARSERS.LIST_SPACES.matches(args)) {
        const brain = getBrain();
        const spaces = Object.keys(brain);
        if (spaces.length === 0) {
            logInfo('No spaces found');
            return;
        }
        logInfo(style('🧠 Spaces:', ['bold', 'magenta']));
        for (let i = 0; i < spaces.length; i++) {
            const space = brain[spaces[i]!];
            logInfo(`   ${style(`${i + 1}. ${spaces[i]}`, ['bold'])}: ${style(space?.description!, ['gray'])}`);
        }
        return;
    }

    if (ARG_PARSERS.READ_SPACE.matches(args)) {
        const { space } = ARG_PARSERS.READ_SPACE.getParams(args);
        const brain = getBrain();
        if (brain[space] === undefined) {
            throw new Error(`Space ${space} does not exist`);
        }
        const content = brain[space];
        logInfo(style(`🛸 ${space}:`, ['bold', 'blue']));
        if (content.memories.length === 0) {
            logInfo(style('   No memories found!', ['dim']));
        } else {
            printMemories(content.memories);
        }
        return;
    }

    if (ARG_PARSERS.RENAME_SPACE.matches(args)) {
        const { old, new: newName } = ARG_PARSERS.RENAME_SPACE.getParams(args);
        const brain = getBrain();
        if (brain[old] === undefined) {
            throw new Error(`Space ${old} does not exist`);
        }
        brain[newName] = brain[old];
        delete brain[old];
        saveBrain(brain);
        logInfo(style(`✅ Space ${old} renamed to ${newName}`, ['bold', 'green']));
        return;
    }

    if (ARG_PARSERS.ADD_TO_SPACE.matches(args)) {
        const { space, value } = ARG_PARSERS.ADD_TO_SPACE.getParams(args);
        const brain = getBrain();
        if (brain[space] === undefined) {
            throw new Error(`Space ${space} does not exist`);
        }
        brain[space].memories.push(value);
        saveBrain(brain);
        logInfo(style(`✅ Memory added: `, ['bold', 'green']) + `\n   ${style(value, ['dim'])}`);
        return;
    }

    if (ARG_PARSERS.REMOVE_FROM_SPACE.matches(args)) {
        const { space, index } = ARG_PARSERS.REMOVE_FROM_SPACE.getParams(args);
        const brain = getBrain();
        if (brain[space] === undefined) {
            throw new Error(`Space ${space} does not exist`);
        }
        if (index < 1 || index > brain[space].memories.length) {
            throw new Error(`Memory index ${index} is not valid for space ${space}`);
        }
        const memory = brain[space].memories[index - 1]!;
        brain[space].memories.splice(index - 1, 1);
        saveBrain(brain);
        logInfo(style(`✅ Memory removed: `, ['bold', 'green']) + `\n   ${style(memory, ['dim'])}`);
        return;
    }

    if (ARG_PARSERS.DELETE_SPACE.matches(args)) {
        const { space } = ARG_PARSERS.DELETE_SPACE.getParams(args);
        const brain = getBrain();
        if (brain[space] === undefined) {
            throw new Error(`Space ${space} does not exist`);
        }
        delete brain[space];
        saveBrain(brain);
        logInfo(style(`✅ Space ${space} deleted`, ['bold', 'green']));
        return;
    }

    if (ARG_PARSERS.CHANGE_SPACE_DESCRIPTION.matches(args)) {
        const { space, description } = ARG_PARSERS.CHANGE_SPACE_DESCRIPTION.getParams(args);
        const brain = getBrain();
        if (brain[space] === undefined) {
            throw new Error(`Space ${space} does not exist`);
        }
        brain[space].description = description;
        saveBrain(brain);
        logInfo(`Space ${space} description changed`);
        return;
    }

    if (ARG_PARSERS.REORDER_SPACE.matches(args)) {
        const params = ARG_PARSERS.REORDER_SPACE.getParams(args);
        params.fromIndex = parseInt(params.fromIndex);
        params.toIndex = parseInt(params.toIndex);
        const { space, fromIndex, toIndex } = params;
        const brain = getBrain();
        if (brain[space] === undefined) {
            throw new Error(`Space ${space} does not exist`);
        }
        const normalizedFromIndex = fromIndex - 1;
        if (normalizedFromIndex < 0 || normalizedFromIndex >= brain[space].memories.length) {
            throw new Error(`Memory index ${fromIndex} is not valid for space ${space}`);
        }

        const memory = brain[space].memories[normalizedFromIndex]!;
        brain[space].memories.splice(normalizedFromIndex, 1);

        if (toIndex === 0) {
            brain[space].memories.unshift(memory);
        } else if (toIndex === -1) {
            console.log(memory);
            brain[space].memories.push(memory);
            console.log(brain[space].memories);
        } else {
            brain[space].memories.splice(toIndex - 1, 0, memory);
        }

        saveBrain(brain);
        logInfo(style(`✅ Memories for space ${space} reordered:`, ['bold', 'green']));
        printMemories(brain[space].memories);
        return;
    }

    throw new Error(`Unknown command ${args[0]}. Run mind help for getting the list of valid commands`);
};
