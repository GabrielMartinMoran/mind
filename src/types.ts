type SpaceName = string;
interface Space {
    description: string;
    memories: string[];
}

export interface Brain {
    [spaceName: SpaceName]: Space;
}
