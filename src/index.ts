import {
  Application,
  ContainerReflection,
  Context,
  Converter,
  DeclarationReflection,
  makeRecursiveVisitor,
  ParameterReflection,
  ParameterType,
  ProjectReflection,
  Reflection,
  ReflectionKind,
  SignatureReflection,
  TypeParameterReflection,
  TypeScript as ts,
} from 'typedoc';

declare module 'typedoc' {
  export interface TypeDocOptionMap {
    internalNamespace: string;
    noMissingExports: boolean;
  }
}

export function load(app: Application) {
  const knownPrograms = new Map<Reflection, ts.Program>();

  app.options.addDeclaration({
    name: 'internalNamespace',
    help: 'Define the name of the namespace that internal symbols which are not exported should be placed into.',
    type: ParameterType.String,
    defaultValue: 'internal',
  });

  app.options.addDeclaration({
    name: 'noMissingExports',
    type: ParameterType.Boolean,
    help: 'Disabling missing export the plugin will only create links between exported Types',
    defaultValue: false,
  });

  app.converter.on(Converter.EVENT_CREATE_DECLARATION, (context: Context) => {
    if (context.scope.kindOf(ReflectionKind.Project | ReflectionKind.Module)) {
      knownPrograms.set(context.scope, context.program);
    }
  });

  app.converter.on(
    Converter.EVENT_RESOLVE_BEGIN,
    onResolveBegin.bind(void 0, knownPrograms),
    void 0,
    1e9
  );
}

function onResolveBegin(knownPrograms: Map<Reflection, ts.Program>, context: Context) {
  const modules: (DeclarationReflection | ProjectReflection)[] = context.project.getChildrenByKind(
    ReflectionKind.Module
  );
  if (modules.length === 0) {
    modules.push(context.project);
  }

  const internalNamespace = context.converter.application.options.getValue('internalNamespace');
  const noMissingExports = context.converter.application.options.getValue('noMissingExports');

  const getModule = (ref: Reflection) => {
    return modules.find((mod) => {
      return mod.getChildrenByKind(ref.kind).find((d) => d.id === ref.id);
    });
  };

  for (const mod of modules) {
    let missing = discoverMissingExports(mod);
    if (missing.size === 0) continue;

    let internalContext: {
      internalContext: Context;
      reflection: Reflection;
    };
    const createInternalContext = () => {
      if (internalContext) return internalContext;
      context.setActiveProgram(knownPrograms.get(mod));
      const internalNs = context
        .withScope(mod)
        .createDeclarationReflection(
          ReflectionKind.Namespace,
          undefined,
          undefined,
          internalNamespace
        );
      context.finalizeDeclarationReflection(internalNs);
      return (internalContext = {
        internalContext: context.withScope(internalNs),
        reflection: internalNs,
      });
    };

    const tried = new Set<ts.Symbol>();
    do {
      for (const m of missing) {
        tried.add(m);

        if (m.name === 'default') continue;
        const ref = context.scope.findReflectionByName(m.name);

        if (ref) {
          const modCtx = getModule(ref!);

          if (modCtx) {
            context.withScope(modCtx).registerReflection(ref, m);
          }

          continue;
        }

        if (noMissingExports) continue;
        const { internalContext } = createInternalContext();
        internalContext.converter.convertSymbol(internalContext, m);
      }

      // If missing exported is disable no need to go recursive
      if (!noMissingExports) {
        const { reflection } = createInternalContext();
        missing = discoverMissingExports(reflection);
      }

      for (const s of tried) {
        missing.delete(s);
      }
    } while (missing.size > 0);

    const { reflection } = createInternalContext();
    //  TODO: Maybe its a problem on future
    //  @ts-ignore
    if (!reflection?.children?.length) {
      context.project.removeReflection(reflection);
    }

    context.setActiveProgram(void 0);
  }

  knownPrograms.clear();
}

export function discoverMissingExports(root: Reflection): Set<ts.Symbol> {
  // This code was copy from other plugin, thanks for the help
  // https://github.com/Gerrit0/typedoc-plugin-missing-exports
  const missing = new Set<ts.Symbol>();
  const queue: Reflection[] = [];
  let current: Reflection | undefined = root;

  const visitor = makeRecursiveVisitor({
    reference(type) {
      if (!type.reflection) {
        const symbol = type.getSymbol();
        if (symbol) {
          missing.add(symbol);
        }
      }
    },
    reflection(type) {
      queue.push(type.declaration);
    },
  });

  const add = (item: Reflection | Reflection[] | undefined) => {
    if (!item) return;

    if (item instanceof Reflection) {
      queue.push(item);
    } else {
      queue.push(...item);
    }
  };

  do {
    // Ugly? Yeah, it is. TypeDoc doesn't have a "visit all types" function,
    // so we have to build our own. This is modeled after the one in
    // https://github.com/TypeStrong/typedoc/blob/beta/src/lib/validation/exports.ts
    if (current instanceof ContainerReflection) {
      add(current.children);
    }

    if (current instanceof DeclarationReflection) {
      current.type?.visit(visitor);
      add(current.typeParameters);
      add(current.signatures);
      add(current.indexSignature);
      add(current.getSignature);
      add(current.setSignature);
      current.overwrites?.visit(visitor);
      current.inheritedFrom?.visit(visitor);
      current.implementationOf?.visit(visitor);
      current.extendedTypes?.forEach((type) => type.visit(visitor));
      // do not validate extendedBy, guaranteed to all be in the documentation.
      current.implementedTypes?.forEach((type) => type.visit(visitor));
      // do not validate implementedBy, guaranteed to all be in the documentation.
    }

    if (current instanceof SignatureReflection) {
      add(current.parameters);
      add(current.typeParameters);
      current.type?.visit(visitor);
      current.overwrites?.visit(visitor);
      current.inheritedFrom?.visit(visitor);
      current.implementationOf?.visit(visitor);
    }

    if (current instanceof ParameterReflection) {
      current.type?.visit(visitor);
    }

    if (current instanceof TypeParameterReflection) {
      current.type?.visit(visitor);
      current.default?.visit(visitor);
    }
  } while ((current = queue.shift()));

  return missing;
}
