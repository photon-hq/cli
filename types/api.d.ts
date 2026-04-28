/**
 * @photon-dashboard/api-public
 *
 * Bundled type definitions for the Photon Dashboard public API.
 * Auto-generated — do not edit by hand.
 */
import { Elysia } from 'elysia';

declare const publicApp: Elysia<"", {
    decorator: {};
    store: {};
    derive: {};
    resolve: {};
}, {
    typebox: {};
    error: {};
} & {
    typebox: {};
    error: {};
}, {
    schema: {};
    standaloneSchema: {};
    macro: {};
    macroFn: {};
    parser: {};
    response: {};
} & {
    schema: {};
    standaloneSchema: {};
    macro: {};
    macroFn: {};
    parser: {};
    response: {};
}, {
    api: {
        projects: {
            get: {
                body: any;
                params: any;
                query: any;
                headers: any;
                response: {
                    [x: string]: any;
                    [x: number]: any;
                    [x: symbol]: any;
                };
            };
        };
    };
} & {
    api: {
        projects: {
            "check-availability": {
                get: {
                    body: unknown;
                    params: {};
                    query: any;
                    headers: any;
                    response: {
                        [x: string]: any;
                        [x: number]: any;
                        [x: symbol]: any;
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                get: {
                    body: any;
                    params: any;
                    query: any;
                    headers: any;
                    response: {
                        [x: string]: any;
                        [x: number]: any;
                        [x: symbol]: any;
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            post: {
                body: any;
                params: {};
                query: any;
                headers: any;
                response: {
                    [x: string]: any;
                    [x: number]: any;
                    [x: symbol]: any;
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                patch: {
                    body: any;
                    params: {
                        id: string;
                    } & {};
                    query: any;
                    headers: any;
                    response: {
                        [x: string]: any;
                        [x: number]: any;
                        [x: symbol]: any;
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                delete: {
                    body: any;
                    params: any;
                    query: any;
                    headers: any;
                    response: {
                        [x: string]: any;
                        [x: number]: any;
                        [x: symbol]: any;
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                spectrum: {
                    toggle: {
                        post: {
                            body: any;
                            params: {
                                id: string;
                            } & {};
                            query: any;
                            headers: any;
                            response: {
                                [x: string]: any;
                                [x: number]: any;
                                [x: symbol]: any;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                "regenerate-secret": {
                    post: {
                        body: any;
                        params: any;
                        query: any;
                        headers: any;
                        response: {
                            [x: string]: any;
                            [x: number]: any;
                            [x: symbol]: any;
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                spectrum: {
                    profile: {
                        get: {
                            body: any;
                            params: any;
                            query: any;
                            headers: any;
                            response: {
                                [x: string]: any;
                                [x: number]: any;
                                [x: symbol]: any;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                spectrum: {
                    profile: {
                        patch: {
                            body: any;
                            params: {
                                id: string;
                            } & {};
                            query: any;
                            headers: any;
                            response: {
                                [x: string]: any;
                                [x: number]: any;
                                [x: symbol]: any;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                spectrum: {
                    "avatar-upload-url": {
                        get: {
                            body: any;
                            params: any;
                            query: any;
                            headers: any;
                            response: {
                                [x: string]: any;
                                [x: number]: any;
                                [x: symbol]: any;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                spectrum: {
                    users: {
                        get: {
                            body: any;
                            params: any;
                            query: any;
                            headers: any;
                            response: {
                                [x: string]: any;
                                [x: number]: any;
                                [x: symbol]: any;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                spectrum: {
                    users: {
                        post: {
                            body: any;
                            params: {
                                id: string;
                            } & {};
                            query: any;
                            headers: any;
                            response: {
                                [x: string]: any;
                                [x: number]: any;
                                [x: symbol]: any;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                spectrum: {
                    users: {
                        ":userId": {
                            delete: {
                                body: any;
                                params: any;
                                query: any;
                                headers: any;
                                response: {
                                    [x: string]: any;
                                    [x: number]: any;
                                    [x: symbol]: any;
                                };
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                spectrum: {
                    users: {
                        invite: {
                            post: {
                                body: any;
                                params: {
                                    id: string;
                                } & {};
                                query: any;
                                headers: any;
                                response: {
                                    [x: string]: any;
                                    [x: number]: any;
                                    [x: symbol]: any;
                                };
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                whatsapp: {
                    connect: {
                        post: {
                            body: any;
                            params: {
                                id: string;
                            } & {};
                            query: any;
                            headers: any;
                            response: {
                                [x: string]: any;
                                [x: number]: any;
                                [x: symbol]: any;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                whatsapp: {
                    phone: {
                        post: {
                            body: any;
                            params: {
                                id: string;
                            } & {};
                            query: any;
                            headers: any;
                            response: {
                                [x: string]: any;
                                [x: number]: any;
                                [x: symbol]: any;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                platforms: {
                    get: {
                        body: any;
                        params: any;
                        query: any;
                        headers: any;
                        response: {
                            [x: string]: any;
                            [x: number]: any;
                            [x: symbol]: any;
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                platforms: {
                    toggle: {
                        post: {
                            body: any;
                            params: {
                                id: string;
                            } & {};
                            query: any;
                            headers: any;
                            response: {
                                [x: string]: any;
                                [x: number]: any;
                                [x: symbol]: any;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                lines: {
                    get: {
                        body: any;
                        params: any;
                        query: any;
                        headers: any;
                        response: {
                            [x: string]: any;
                            [x: number]: any;
                            [x: symbol]: any;
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                lines: {
                    post: {
                        body: any;
                        params: {
                            id: string;
                        } & {};
                        query: any;
                        headers: any;
                        response: {
                            [x: string]: any;
                            [x: number]: any;
                            [x: symbol]: any;
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                lines: {
                    ":lineId": {
                        delete: {
                            body: any;
                            params: any;
                            query: any;
                            headers: any;
                            response: {
                                [x: string]: any;
                                [x: number]: any;
                                [x: symbol]: any;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        billing: {
            plans: {
                get: {
                    body: any;
                    params: any;
                    query: any;
                    headers: any;
                    response: {
                        [x: string]: any;
                        [x: number]: any;
                        [x: symbol]: any;
                    };
                };
            };
        };
    };
} & {
    api: {
        billing: {
            checkout: {
                post: {
                    body: any;
                    params: {};
                    query: any;
                    headers: any;
                    response: {
                        [x: string]: any;
                        [x: number]: any;
                        [x: symbol]: any;
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                subscription: {
                    get: {
                        body: any;
                        params: any;
                        query: any;
                        headers: any;
                        response: {
                            [x: string]: any;
                            [x: number]: any;
                            [x: symbol]: any;
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                subscription: {
                    poll: {
                        get: {
                            body: any;
                            params: any;
                            query: any;
                            headers: any;
                            response: {
                                [x: string]: any;
                                [x: number]: any;
                                [x: symbol]: any;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        projects: {
            ":id": {
                subscription: {
                    manage: {
                        post: {
                            body: any;
                            params: any;
                            query: any;
                            headers: any;
                            response: {
                                [x: string]: any;
                                [x: number]: any;
                                [x: symbol]: any;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        profile: {
            get: {
                body: any;
                params: any;
                query: any;
                headers: any;
                response: {
                    [x: string]: any;
                    [x: number]: any;
                    [x: symbol]: any;
                };
            };
        };
    };
} & {
    api: {
        profile: {
            developer: {
                post: {
                    body: any;
                    params: {};
                    query: any;
                    headers: any;
                    response: {
                        [x: string]: any;
                        [x: number]: any;
                        [x: symbol]: any;
                    };
                };
            };
        };
    };
} & {
    api: {
        profile: {
            organization: {
                post: {
                    body: any;
                    params: {};
                    query: any;
                    headers: any;
                    response: {
                        [x: string]: any;
                        [x: number]: any;
                        [x: symbol]: any;
                    };
                };
            };
        };
    };
} & {
    api: {
        otp: {
            email: {
                send: {
                    post: {
                        body: any;
                        params: {};
                        query: any;
                        headers: any;
                        response: {
                            [x: string]: any;
                            [x: number]: any;
                            [x: symbol]: any;
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        otp: {
            email: {
                verify: {
                    post: {
                        body: any;
                        params: {};
                        query: any;
                        headers: any;
                        response: {
                            [x: string]: any;
                            [x: number]: any;
                            [x: symbol]: any;
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        otp: {
            phone: {
                send: {
                    post: {
                        body: any;
                        params: {};
                        query: any;
                        headers: any;
                        response: {
                            [x: string]: any;
                            [x: number]: any;
                            [x: symbol]: any;
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        otp: {
            phone: {
                verify: {
                    post: {
                        body: any;
                        params: {};
                        query: any;
                        headers: any;
                        response: {
                            [x: string]: any;
                            [x: number]: any;
                            [x: symbol]: any;
                        };
                    };
                };
            };
        };
    };
} & {
    api: {
        health: {
            get: {
                body: any;
                params: any;
                query: any;
                headers: any;
                response: {
                    [x: string]: any;
                    [x: number]: any;
                    [x: symbol]: any;
                };
            };
        };
    };
} & {
    api: {
        info: {
            get: {
                body: any;
                params: any;
                query: any;
                headers: any;
                response: {
                    [x: string]: any;
                    [x: number]: any;
                    [x: symbol]: any;
                };
            };
        };
    };
}, {
    derive: {};
    resolve: {};
    schema: {};
    standaloneSchema: {};
    response: {};
}, {
    derive: {};
    resolve: {};
    schema: {};
    standaloneSchema: {};
    response: {
        200: Response;
    };
} & {
    derive: {};
    resolve: {};
    schema: {};
    standaloneSchema: {};
    response: {};
}>;
type PublicApp = typeof publicApp;

export type { PublicApp };
