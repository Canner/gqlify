import Model from '../dataModel/model';
import {Context, Plugin} from './interface';
import WhereInputPlugin from './whereInput';
import BaseTypePlugin from './baseType';
import ObjectField from '../dataModel/objectField';
import {upperFirst, forEach, get} from 'lodash';
import {ListMutable} from '../dataSource/interface';
import {RelationField, ScalarField} from '../dataModel';
import {Hook, CreateContext} from '../hooks/interface';
import {MutationFactory} from './mutation';

const createObjectInputField = (
  prefix: string,
  field: ObjectField,
  context: Context
) => {
  const {root} = context;
  const content: string[] = [];

  forEach(field.getFields(), (nestedField, name) => {
    if (nestedField.isScalar()) {
      content.push(`${name}: ${nestedField.getTypename()}`);
      return;
    }

    if (nestedField instanceof ObjectField) {
      const fieldWithPrefix = `${prefix}${upperFirst(name)}`;
      const typeFields = createObjectInputField(
        fieldWithPrefix,
        nestedField,
        context
      );
      const objectInputName = `${fieldWithPrefix}CreateInput`;
      root.addInput(`input ${objectInputName} {${typeFields.join(' ')}}`);

      content.push(`${name}: ${objectInputName}`);
      return;
    }

    // skip relation, dont support relation in nested object for now
  });

  return content;
};

const createInputField = (
  model: Model,
  context: Context,
  getCreateInputName: (model: Model) => string,
  getWhereInputName: (model: Model) => string,
  getWhereUniqueInputName: (model: Model) => string,
  getMutationFactoryFromModel: (model: Model) => MutationFactory
) => {
  const {root} = context;
  const capName = model.getNamings().capitalSingular;
  const fields = model.getFields();
  const content: string[] = [];
  const mutationFactory = getMutationFactoryFromModel(model);
  forEach(fields, (field, name) => {
    if (field.isAutoGenerated()) {
      return;
    }

    if (field.isScalar()) {
      let fieldType: string;
      if (field.isList()) {
        // wrap with set field
        const fieldWithPrefix = `${capName}${upperFirst(name)}`;
        const listOperationInput = `${fieldWithPrefix}CreateInput`;
        root.addInput(
          `input ${listOperationInput} {set: [${field.getTypename()}]}`
        );
        fieldType = listOperationInput;
        mutationFactory.markArrayField(name);
      } else {
        fieldType = field.getTypename();
      }
      content.push(`${name}: ${fieldType}`);
      return;
    }

    // object field
    if (field instanceof ObjectField) {
      // create input for nested object
      const fieldWithPrefix = `${capName}${upperFirst(name)}`;
      const typeFields = createObjectInputField(
        fieldWithPrefix,
        field,
        context
      );
      const objectInputName = `${fieldWithPrefix}CreateInput`;
      root.addInput(`input ${objectInputName} {${typeFields.join(' ')}}`);

      let fieldType: string;
      if (field.isList()) {
        // wrap with set field
        const listOperationInput = `${fieldWithPrefix}CreateListInput`;
        root.addInput(
          `input ${listOperationInput} {set: [${objectInputName}]}`
        );
        fieldType = listOperationInput;
        mutationFactory.markArrayField(name);
      } else {
        fieldType = objectInputName;
      }
      content.push(`${name}: ${fieldType}`);
      return;
    }

    // relation
    // add create and connect for relation
    const isRelation = field instanceof RelationField;
    const isList = field.isList();
    if (isRelation && !isList) {
      // to-one
      const relationTo = (field as RelationField).getRelationTo();
      const relationInputName = `${capName}CreateOneInput`;
      root.addInput(`input ${relationInputName} {
        create: ${getCreateInputName(relationTo)}
        connect: ${getWhereUniqueInputName(relationTo)}
      }`);
      content.push(`${name}: ${relationInputName}`);
      return;
    }

    if (isRelation && isList) {
      // to-many
      const relationTo = (field as RelationField).getRelationTo();
      const relationInputName = `${capName}CreateManyInput`;
      root.addInput(`input ${relationInputName} {
        create: [${getCreateInputName(relationTo)}]
        connect: [${getWhereUniqueInputName(relationTo)}]
      }`);
      content.push(`${name}: ${relationInputName}`);
      return;
    }
  });

  return content;
};

export default class CreatePlugin implements Plugin {
  private whereInputPlugin: WhereInputPlugin;
  private baseTypePlugin: BaseTypePlugin;
  private hook: Hook;

  constructor({hook}: {hook: Hook}) {
    this.hook = hook;
  }

  public setPlugins(plugins: Plugin[]) {
    this.whereInputPlugin = plugins.find(
      plugin => plugin instanceof WhereInputPlugin
    ) as WhereInputPlugin;
    this.baseTypePlugin = plugins.find(
      plugin => plugin instanceof BaseTypePlugin
    ) as BaseTypePlugin;
  }

  public visitModel(model: Model, context: Context) {
    // object type model dont need create mutation
    if (model.isObjectType()) {
      return;
    }
    const {root} = context;
    const modelType = this.baseTypePlugin.getTypename(model);

    // create
    const mutationName = this.getMutationName(model);
    const inputName = this.generateCreateInput(model, context);
    root.addMutation(`${mutationName}(data: ${inputName}!): ${modelType}`);
  }

  public resolveInMutation({
    model,
    dataSource
  }: {
    model: Model;
    dataSource: ListMutable;
  }) {
    // object type model dont need create mutation
    if (model.isObjectType()) {
      return;
    }

    const mutationName = this.getMutationName(model);
    const wrapCreate = get(this.hook, [model.getName(), 'wrapCreate']);

    return {
      [mutationName]: async (root, args, context) => {
        // args may not have `hasOwnProperty`.
        // https://github.com/Canner/gqlify/issues/29
        const data = {...args.data};

        // no relationship or other hooks
        if (!wrapCreate) {
          return dataSource.create(this.createMutation(model, data), context);
        }

        // wrap
        // put mutationFactory to context
        // so hooks can access it
        // todo: find a better way to share the mutationFactory
        const createContext: CreateContext = {
          data,
          response: {},
          graphqlContext: context
        };
        await wrapCreate(createContext, async ctx => {
          ctx.response = await dataSource.create(
            this.createMutation(model, ctx.data),
            context
          );
        });
        return createContext.response;
      }
    };
  }

  public getCreateInputName(model: Model) {
    return `${model.getNamings().capitalSingular}CreateInput`;
  }

  private generateCreateInput(model: Model, context: Context) {
    const inputName = this.getCreateInputName(model);
    const input = `input ${inputName} {
      ${createInputField(
        model,
        context,
        this.getCreateInputName,
        this.whereInputPlugin.getWhereInputName,
        this.whereInputPlugin.getWhereUniqueInputName,
        model.getCreateMutationFactory
      )}
    }`;
    context.root.addInput(input);
    return inputName;
  }

  private getMutationName(model: Model) {
    return `create${model.getNamings().capitalSingular}`;
  }

  private createMutation = (model: Model, payload: any) => {
    const mutationFactory = model.getCreateMutationFactory();
    return mutationFactory.createMutation(payload);
  };
}
