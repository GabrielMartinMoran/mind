import { ArgParser } from './arg-parser';
import { createSpace, getBrain, listSpaces, saveBrain } from './storage';

export const param = (name: string): string => {
    return ArgParser.param(name);
};

const ARG_PARSERS = {
    HELP: new ArgParser(['help|h']),
    CREATE_SPACE: new ArgParser(['create|c', param('space')]),
    LIST_SPACES: new ArgParser(['list|ls|l']),
    READ_SPACE: new ArgParser(['read|r', param('space')]),
    RENAME_SPACE: new ArgParser(['rename|rn', param('old'), param('new')]),
    ADD_TO_SPACE: new ArgParser(['add|a', param('space'), param('value')]),
    REMOVE_FROM_SPACE: new ArgParser(['remove|rm', param('space'), param('index')]),
    DELETE_SPACE: new ArgParser(['delete|d', param('space')]),
};

const execute = () => {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        throw new Error('No arguments provided');
    }

    if (ARG_PARSERS.HELP.matches(args)) {
        console.log('Allowed commands:');
        for (const parser of Object.values(ARG_PARSERS)) {
            console.log(`   mind ${parser.getRenderedShape()}`);
        }
        return;
    }

    if (ARG_PARSERS.CREATE_SPACE.matches(args)) {
        const { space } = ARG_PARSERS.CREATE_SPACE.getParams(args);
        createSpace(space);
        console.log(`Space ${space} created`);
        return;
    }

    if (ARG_PARSERS.LIST_SPACES.matches(args)) {
        const spaces = listSpaces();
        if (spaces.length === 0) {
            console.log('No spaces found');
            return;
        }
        for (const space of spaces) {
            console.log(space);
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
        console.log(`${space}:`);
        if (content.length === 0) {
            console.log('   > No memories found');
        } else {
            for (let i = 0; i < content.length; i++) {
                console.log(`   ${i + 1}. ${content[i]}`);
            }
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
        console.log(`Space ${old} renamed to ${newName}`);
        return;
    }

    if (ARG_PARSERS.ADD_TO_SPACE.matches(args)) {
        const { space, value } = ARG_PARSERS.ADD_TO_SPACE.getParams(args);
        const brain = getBrain();
        if (brain[space] === undefined) {
            throw new Error(`Space ${space} does not exist`);
        }
        brain[space].push(value);
        saveBrain(brain);
        console.log(`Memory added`);
        return;
    }

    if (ARG_PARSERS.REMOVE_FROM_SPACE.matches(args)) {
        const { space, index } = ARG_PARSERS.REMOVE_FROM_SPACE.getParams(args);
        const brain = getBrain();
        if (brain[space] === undefined) {
            throw new Error(`Space ${space} does not exist`);
        }
        const memory = brain[space][index - 1];
        brain[space].splice(index - 1, 1);
        saveBrain(brain);
        console.log(`Memory removed: ${memory}`);
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
        console.log(`Space ${space} deleted`);
        return;
    }

    throw new Error(`Unknown command ${args[0]}. Run mind help for getting the list of valid commands`);
};

try {
    execute();
} catch (e: any) {
    console.error(e.message);
    process.exit(1);
}
