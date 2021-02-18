'use strict';

class ServerlessEngine {
  constructor(serverless, options) {
    this.initialized = false;
    this.serverless = serverless;
    this.options = options;
    this.naming = this.serverless.providers.aws.naming;

    this.hooks = {
      'after:package:setupProviderConfiguration': this.setupProviderConfiguration.bind(this),
      'after:package:compileEvents': this.compileEvents.bind(this),
      'after:package:compileFunctions': this.createCustomDomain.bind(this),
      'before:package:finalize': this.beforePackageFinalize.bind(this),
      'before:deploy:deploy': this.beforeDeploy.bind(this),
      'before:aws:deploy:deploy:createStack': this.createStack.bind(this),
      'after:aws:deploy:deploy:createStack': this.addLambdaPermission.bind(this),

      'after:aws:deploy:finalize:cleanup': this.afterDeployFinalizeCleanup.bind(this)
    };
  }

  //LOGS
  //this.serverless.cli.log(JSON.stringify(apiGateway))
  //throw new Error(JSON.stringify(this.api))

  initializeVariables() {
    if (!this.initialized) {
      const awsCreds = Object.assign({}, this.serverless.providers.aws.getCredentials(), { region: this.serverless.service.provider.region })

      this.apiGateway = new this.serverless.providers.aws.sdk.APIGateway(awsCreds)
      this.cloudFormation = new this.serverless.providers.aws.sdk.CloudFormation(awsCreds)
      this.lambda = new this.serverless.providers.aws.sdk.Lambda(awsCreds)
      this.acm = new this.serverless.providers.aws.sdk.ACM(awsCreds)
      this.route53 = new this.serverless.providers.aws.sdk.Route53(awsCreds)
      this.s3 = new this.serverless.providers.aws.sdk.S3(awsCreds)
      this.cloudFront = new this.serverless.providers.aws.sdk.CloudFront(awsCreds)
      this.ssm = new this.serverless.providers.aws.sdk.SSM(awsCreds)
      this.resourcesCloudFormation = {}

      this.initialized = true
    }
  }

  async setupProviderConfiguration(){
    this.initializeVariables()

    await this.manipulateResources()
    await this.createModels()
  }

  async compileEvents(){
    this.initializeVariables()

    await this.addStageVariableApiFunction()
    await this.addRequestValidator()
  }

  async beforePackageFinalize(){
    this.initializeVariables()

    await this.manipulateDocumentation()
    await this.createAuthorizer()
  }

  async beforeDeploy(){
    this.initializeVariables()

    await this.createBasePathMappings()
  }

  async createStack(){
    this.initializeVariables()

    await this.createDocumentationPath()
  }

  async afterDeployFinalizeCleanup() {
    this.initializeVariables()

    await this.addStageVariables()
    await this.exportSwaggerToS3()
  }

  //Esse metodo eh responsavel por criar/referenciar resources/apigateway
  async manipulateResources() {

    this.initializeVariables()

    //const JSON = require('circular-json')
    this.apiName = this.serverless.service.provider.apiName
    this.moduloName = this.serverless.service.provider.moduloName
    this.stackName = this.serverless.service.provider.stackName

    if(!this.apiName){
      this.serverless.cli.log(`ApiName não informada`)
      return
    }

    //Conseguindo informacoes das stacks geradas
    let cloudFormationTemplate = {}
    let cloudFormationTemplateAlias = {}

    try {
      let {TemplateBody} = await this.cloudFormation.getTemplate({
        "StackName": this.apiName + '-' + this.moduloName + '-' + this.stackName
      }).promise()
      cloudFormationTemplate = JSON.parse(TemplateBody).Resources
    }catch(e){
      this.serverless.cli.log('Stack não criada');
    }

    try {
      let {TemplateBody} = await this.cloudFormation.getTemplate({
        "StackName": this.apiName + '-' + this.moduloName + '-' + this.stackName + '-' + this.serverless.service.provider.stage
      }).promise()
      cloudFormationTemplateAlias = JSON.parse(TemplateBody).Resources
    }catch(e){
      this.serverless.cli.log('Stack não criada');
    }

    Object.keys(cloudFormationTemplate).forEach (key => {
      if(cloudFormationTemplate[key].Type == "AWS::ApiGateway::Resource"  ||
        cloudFormationTemplate[key].Type == "AWS::ApiGateway::RestApi"    ||
        cloudFormationTemplate[key].Type == "AWS::ApiGateway::Authorizer" ||
        cloudFormationTemplate[key].Type == "AWS::ApiGateway::BasePathMapping"){
        this.resourcesCloudFormation[key] = cloudFormationTemplate[key]
      }
    })

    Object.keys(cloudFormationTemplateAlias).forEach (key => {
      if(cloudFormationTemplateAlias[key].Type == "AWS::ApiGateway::Resource"  ||
        cloudFormationTemplateAlias[key].Type == "AWS::ApiGateway::RestApi"    ||
        cloudFormationTemplateAlias[key].Type == "AWS::ApiGateway::Authorizer"      ||
        cloudFormationTemplateAlias[key].Type == "AWS::ApiGateway::BasePathMapping"){
        this.resourcesCloudFormation[key] = cloudFormationTemplateAlias[key]
      }
    })

    //Conseguindo a lista de apis
    const {items} = await this.apiGateway.getRestApis({limit:1000}).promise()

    //Verificando se existe a API
    this.api = items.filter(api => api.name === this.apiName)

    //Paths ja existentes
    let resources = []

    let apiGateway = Object.keys(this.resourcesCloudFormation).reduce((arr, key) => {
      if (this.resourcesCloudFormation[key].Type === 'AWS::ApiGateway::RestApi') {
        arr.push(this.resourcesCloudFormation[key])
      }
      return arr
    }, [])

    //A Api já existe so se faz necessario realizar a referencia
    // e o resource de criacao da API esta em outra stack
    if (this.api.length == 1 && apiGateway.length == 0){
      this.api = this.api[0]
      //Adicionando a referencia caso a mesma ja exista na referencia cross stack (outputs no momento da criacao)
      this.serverless.service.provider.apiGateway = {
        "restApiId": this.api.id
      }

      //conseguindo os path ja criados
      let hasMoreResults = true
      let currentPosition = null
      //conseguindo todos os resources da api
      do {
        const {position, items} = await this.apiGateway.getResources({position: currentPosition, restApiId: this.api.id, limit: 500}).promise()
        resources = resources.concat(items)
        currentPosition = position
        hasMoreResults = position && items.length === 500
      } while (hasMoreResults)

      this.apiResources = resources

      //Se nao existir o resource no json, cria para adicionar as opcoes dentro dele
      if(!this.serverless.service.provider.apiGateway.hasOwnProperty('restApiResources')){
        this.serverless.service.provider.apiGateway = Object.assign(this.serverless.service.provider.apiGateway,{"restApiResources":{}})
      }

      let paths = []
      Object.keys(this.serverless.service.functions).forEach (fn => {
        let func = this.serverless.service.functions[fn]
        func.events.forEach (event => {
          if(event.http){
            let path = event.http.path
            let resourceInAWS

            do{
              resourceInAWS = resources.filter(res => res.path === `/${path}`)[0]
              path = path.split('/')
              path.pop()
              path = path.join('/')
            } while(resourceInAWS === undefined)

            //conseguindo todos os partial paths que compoe esse path
            paths.push(resourceInAWS)
            let parentIdRaiz = resourceInAWS.parentId
            while (true){
              const res = resources.filter((resource) => resource.id === parentIdRaiz)[0]
              if(!res) break
              parentIdRaiz = res.parentId

              if(!paths.includes((p) => p.id === res.id)){
                paths.push(res)
              }
            }
          }
        })
      })

      paths = [...new Set(paths)]

      //Agora removo os recursos que devem ser criados nesse cloudformation
      //Caso o meu cloudFormation possua esse resource (isso significa que o recurso foi criado nesse CloudFormation) eu nao posso referenciar, pois o mesmo eh apagado
      //Por isso removo do meu array de paths
      for (let i = 0; i < paths.length; ++i){
        // console.log(paths[i])
        for (const key of Object.keys(this.resourcesCloudFormation)) {
          //Utilizo o parent id e o pathPart pois não tenho acesso ao id dentro do resourcesCloudFormation
          const parentId = this.resourcesCloudFormation[key].Properties.ParentId
          const pathPart = this.resourcesCloudFormation[key].Properties.PathPart
          if(pathPart && pathPart == paths[i].pathPart && (parentId == paths[i].parentId || (parentId.Ref && this.resourcesCloudFormation[parentId.Ref] ))){
            paths.splice(i--, 1)
            break
          }
        }
      }

      for (const path of paths.reverse()){
        if(path.path == "/"){
          this.serverless.service.provider.apiGateway = Object.assign(this.serverless.service.provider.apiGateway, {
            "restApiRootResourceId": path.id
          })
        }else{
          this.serverless.service.provider.apiGateway.restApiResources = Object.assign(this.serverless.service.provider.apiGateway.restApiResources,
          {
            [path.path.substr(1,path.path.length)]: path.id
          })
        }
      }

    //A Api não existe criar uma adicionando o json diretamente no serverless.yml
    //Juntamente com o outpu para o funcionamento da funcao "Fn::ImportValue" em outras stacks
    }else{

      this.api = false

      //Criando as opções dentro do objeto caso não exista
      if(!this.serverless.service.resources) {
        this.serverless.service.resources = {"Resources":{},"Outputs":{}}
      }

      // Adicionando o resource de criacao da API
      // Resource de criação do requestValidator
      this.serverless.service.resources.Resources = Object.assign(this.serverless.service.resources.Resources,
      {
        "ApiGatewayRestApi": {
          "Type": "AWS::ApiGateway::RestApi",
          "Properties": {
            "Name": this.apiName,
            "Description": "API com as funcionalidades da " + this.apiName,
            "EndpointConfiguration": {
              "Types": [
                "EDGE"
              ]
            },
            "Policy": {
              "Version": "2012-10-17",
              "Statement": [
                {
                  "Effect": "Allow",
                  "Principal": "*",
                  "Action": "execute-api:Invoke",
                  "Resource": [
                    "execute-api:/*/*/*"
                  ]
                }
              ]
            }
          }
        },
        "RequestValidatorBody": {
          "Type": "AWS::ApiGateway::RequestValidator",
          "Properties": {
            "Name": "body",
            "RestApiId": {
              "Ref": "ApiGatewayRestApi"
            },
            "ValidateRequestBody": true,
            "ValidateRequestParameters": false
          }
        },
        "RequestValidatorParams": {
          "Type": "AWS::ApiGateway::RequestValidator",
          "Properties": {
            "Name": "params",
            "RestApiId": {
              "Ref": "ApiGatewayRestApi"
            },
            "ValidateRequestBody": false,
            "ValidateRequestParameters": true
          }
        },
        "RequestValidatorBodyParams": {
          "Type": "AWS::ApiGateway::RequestValidator",
          "Properties": {
            "Name": "body-and-params",
            "RestApiId": {
              "Ref": "ApiGatewayRestApi"
            },
            "ValidateRequestBody": true,
            "ValidateRequestParameters": true
          }
        },
      })
    }

    let service = this.serverless.service
    //Criando o authorizer compartilhado
    if (service.custom && service.custom.authorizerConfig){

      //Criando as opções dentro do objeto caso não exista
      if(!this.serverless.service.resources) {
        this.serverless.service.resources = {"Resources":{},"Outputs":{}}
      }

      let name = service.custom.authorizerConfig.name
      let arn = service.custom.authorizerConfig.arn
      let type = service.custom.authorizerConfig.type
      let identitySource = service.custom.authorizerConfig.identitySource

      let needCreateAuthorizer = false

      if(this.api){
        //verificando se o authorizer ja existe
        const {items} = await this.apiGateway.getAuthorizers({restApiId: this.api.id, limit: 500}).promise()

        let authorizer = Object.keys(this.resourcesCloudFormation).reduce((arr, key) => {
          if (this.resourcesCloudFormation[key].Type === 'AWS::ApiGateway::Authorizer') {
            arr.push(this.resourcesCloudFormation[key])
          }
          return arr
        }, [])

        needCreateAuthorizer = (!items.some(e => e.name === name) || authorizer.some(e => e.Properties && e.Properties.Name === name))
      }else{
        //não existe api, logo preciso criar o authorizer de qualquer forma
        needCreateAuthorizer = true
      }

      //não existe!!! preciso criar
      if(needCreateAuthorizer){

        if (name == null || name.trim() === '') {
          name = service.provider.apiName
        }

        if (arn == null || arn.trim() === '') {
          throw new Error('Error: Favor configurar o arn da função lambda utilizada como authorizer no serverless.yml')
        }

        //verificando se existe a função informada no ARN
        try {
          let lambdaName = arn.split(":")
          lambdaName = lambdaName[lambdaName.length-1]
          await this.lambda.getFunction({FunctionName: lambdaName}).promise()
        }catch(e){
          throw new Error('Error: O arn da função lambda utilizada como authorizer não existe')
        }

        if (type == null || type.trim() === '') {
          type = "REQUEST"
        }

        if (identitySource == null) {
          identitySource = ""
        }

        let restApiId = {
          "Ref": "ApiGatewayRestApi"
        }

        if(this.api) {
          restApiId = this.api.id
        }

        //Adicionando o resource de criação da API
        this.serverless.service.resources.Resources = Object.assign(this.serverless.service.resources.Resources,
        {
          "ApiGatewayAuthorizer":{
            "Type": "AWS::ApiGateway::Authorizer",
            "Properties": {
              "Name": name,
              "Type": type,
              "IdentitySource": identitySource,
              "AuthorizerResultTtlInSeconds": 0,
              "AuthorizerUri": {
                "Fn::Join": [
                  "",
                  [
                    "arn:",
                    {
                      "Ref": "AWS::Partition"
                    },
                    ":apigateway:",
                    {
                      "Ref": "AWS::Region"
                    },
                    ":lambda:path/2015-03-31/functions/",
                    {
                      "Fn::Sub": arn.replace(new RegExp('#','g'), '$')
                    },
                    "/invocations"
                  ]
                ]
              },
              "RestApiId": restApiId
            },
          },
          "GatewayResponse": {
            "Type": "AWS::ApiGateway::GatewayResponse",
            "Properties": {
              "ResponseType": "ACCESS_DENIED",
              "ResponseTemplates": {
                "application/json": "$context.authorizer.retorno"
              },
              "RestApiId": restApiId,
              "StatusCode": "403"
            }
          }
        })
      }
    }

    //Adicionando as informacoes da documantacao da api caso o mesmo esteja definido
    if(this.serverless.service.custom.documentation){

      //Acertando as tags/modulos da api
      let tags = []

      //Se existir a API eu consigo as documantacoes ja existentes
      if(this.api){
        let documentationParts = await this.apiGateway.getDocumentationParts({
          "restApiId": this.api.id
        }).promise()

        let documentationAPIPart = documentationParts.items.filter(part => {
          return part.location.type === "API"
        })[0]

        let documantationTAG = JSON.parse(documentationAPIPart.properties).tags.filter(tag => {
          return tag.name !== this.moduloName
        })

        documantationTAG.forEach(tag => {
          tags.push({
            "name": tag.name,
            "description": tag.description
          })
        })
      }

      tags.push({
        "name": this.moduloName,
        "description": this.serverless.service.custom.documentation.moduloDescription
      })

      let apiDocumentationParams = {
        "api": {
          "info": {
            "version": '1',
            "title": this.apiName,
            "description": this.serverless.service.custom.documentation.apiDescription
          },
          "tags": tags
        }
      }

      if(this.serverless.service.custom.documentation.apiDescription){
        apiDocumentationParams.api.info.description = this.serverless.service.custom.documentation.apiDescription
      }

      this.serverless.service.custom.documentation = Object.assign(this.serverless.service.custom.documentation, apiDocumentationParams)
    }
  }

  async createModels(){
    const models = []
    const custom = this.serverless.service.custom || false
    const functions = this.serverless.service.functions || false

    if(custom && custom.documentation && functions && !Object.keys(custom.documentation).some(key => key === 'models')){
      const schemas = require('schemas').schemas()

      const methodResponsesInexistentes = []
      // verificando se existe todos o methods response informados
      for(const key of Object.keys(functions)){
        if(functions[key].events) {
          for (const event of functions[key].events){
            if(event.http &&
              event.http.documentation &&
              event.http.documentation.methodResponses){
                for (const methodResponse of event.http.documentation.methodResponses){
                  if(!schemas.some(schema => schema.name === methodResponse)){
                    methodResponsesInexistentes.push(methodResponse)
                  }
                }
            }
          }
        }
      }

      if(methodResponsesInexistentes.length > 0){
        throw new Error(`Não foi possível encontrar os arquivos de schemas ${ methodResponsesInexistentes.join(', ') }, verificar se a nomenclatura do arquivo de schema, dos methods response e da função estão corretas!!!`)
      }

      for (const model of schemas){
        const schema = model.schema
        const modelName = this.naming.normalizePath(model.name)
        const modelInfo = model.name.split('-')

        const functionName = modelInfo[0]
        const method = modelInfo[1]
        const type = modelInfo[2]

        const finalModel = {
          name: modelName,
          contentType: 'application/json',
          schema: {
            type: 'object',
            properties: {}
          }
        }

        function getRequired(value){
          const required = []
          Object.keys(value).forEach(key => {
            if (key.includes('.required')){
              key = key.replace('.required', '')
              required.push(key)
            }
          })
          return required
        }

        function build(schema){
          let newSchema = {}
          Object.entries(schema).map(([field, value]) => {
            let type = ''
            let required = []

            if(Array.isArray(value)){
              type = 'array'
              if(field.includes('.required')){
                required = true
              }else{
                required = false
              }
            } else if(typeof value === 'object'){
              type = 'object'
              required = getRequired(value)
            } else {
              type = value
            }

            Object.assign(newSchema, getType[type](field.replace('.required', ''), value, required))
          })
          return newSchema
        }

        const getType = {
          array: (field, value, required = false) => {
            if(required){
              return {
                [field]: {
                  type: 'array',
                  items: build(value),
                  minItems: 1
                }
              }
            }

            return {
              [field]: {
                type: 'array',
                items: build(value)
              }
            }
          },

          object: (field, value, required) => {
            if(isNaN(field)){ //true se não for um numero valido
              if(required.length > 0){
                return {
                  [field]: {
                    type: 'object',
                    properties: build(value),
                    required: required
                  }
                }
              }

              return {
                [field]: {
                  type: 'object',
                  properties: build(value)
                }
              }
            }

            if(required.length > 0){
              return {
                type: 'object',
                properties: build(value),
                required: required
              }
            }

            return {
              type: 'object',
              properties: build(value)
            }
          },

          string: (field) => {
            if(isNaN(field)){
              return {
                [field]: {
                  type: 'string'
                }
              }
            }

            return {
              type: 'string'
            }
          },

          number: (field) => {
            if(isNaN(field)){
              return {
                [field]: {
                  type: 'number'
                }
              }
            }

            return {
              type: 'number'
            }
          },

          email: (field) => {
            if(isNaN(field)){
              return {
                [field]: {
                  type: 'string',
                  format: 'email'
                }
              }
            }

            return {
              type: 'string',
              format: 'email'
            }
          },

          date: (field) => {
            if(isNaN(field)){
              return {
                [field]: {
                  type: 'string',
                  format: 'date'
                }
              }
            }

            return {
              type: 'string',
              format: 'date'
            }
          },

          'date-time': (field) => {
            if(isNaN(field)){
              return {
                [field]: {
                  type: 'string',
                  format: 'date-time'
                }
              }
            }

            return {
              type: 'string',
              format: 'date-time'
            }
          },

          double: (field) => {
            if(isNaN(field)){
              return {
                [field]: {
                  type: 'number',
                  format: 'double'
                }
              }
            }

            return {
              type: 'number',
              format: 'double'
            }
          },

          boolean: (field) => {
            if(isNaN(field)){
              return {
                [field]: {
                  type: 'boolean'
                }
              }
            }

            return {
              type: 'boolean'
            }
          }
        }

        const func = functions[functionName]
        if(func && func.events){
          const event = func.events.filter(event => event.http && event.http.method.toLowerCase() === method)[0]

          if(event && event.http){
            finalModel.schema.properties = build(schema)
            const required = getRequired(schema)
            if(required.length > 0){
              finalModel.schema.required = required
            }
            models.push(finalModel)

            if(type === 'request'){
              event.http.documentation.requestModels['application/json'] = modelName
            }

            if(type === 'response'){
              const index = event.http.documentation.methodResponses.indexOf(model.name)
              if(index !== -1){
                const statusCode = modelInfo[3]
                event.http.documentation.methodResponses[index] = {
                  statusCode: statusCode,
                  responseModels: {
                    "application/json": modelName
                  }
                }
              }
            }
          }
        } else {
          throw new Error(`Não foi possível encontrar a função ${functionName}, verificar se a nomenclatura do arquivo de schema e da função estão corretas!!!`)
        }
      }

      custom.documentation.models = models
    }
  }

  //Preciso adicionar o stage
  async addStageVariables() {

    //Conseguindo a lista de apis
    const {items} = await this.apiGateway.getRestApis({limit:1000}).promise()

    //Verificando se existe a API
    this.api = items.filter(api => api.name === this.apiName)[0]

    //Voltando as variaveis que por algum motivo sao deletadas kkk
    await this.apiGateway.updateStage({
      restApiId: this.api.id,
      stageName: this.serverless.service.provider.stage,
      patchOperations: [
        { op: "replace", path: "/variables/SERVERLESS_ALIAS", value: this.serverless.service.provider.stage },
        { op: "replace", path: "/variables/SERVERLESS_STAGE", value: this.serverless.service.provider.stage }
      ]
    }).promise()

    //Ajustando o nome da funcao

    //Conseguindo os functions names
    const Resources = this.serverless.service.provider.compiledCloudFormationTemplate.Resources
    let lambdaFunctions = Object.keys(Resources).reduce((arr, fn) => {
      if (Resources[fn].Type === 'AWS::Lambda::Function') {
        arr.push({
          functionKey: fn,
          functionName: Resources[fn].Properties.FunctionName,
          sourceAccount: Resources[fn].Properties.Role.split(':')[4]
        })
      }
      return arr
    }, [])

    //utilizado para substituir foreach e await/ verificar possibilidades melhores
    const asyncForEach = async (array, callback) => {
      for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array)
      }
    }

    if(this.serverless.service.provider.stage == "dev"){
      //Preciso do method e do path
      const start = async () => {
        await asyncForEach(Object.keys(this.serverless.service.functions), async (fn) => {
        //Object.keys(this.serverless.service.functions).forEach (async (fn) => {
          let func = this.serverless.service.functions[fn]

          //func.events.forEach (async (event) => {
          await asyncForEach(func.events, async (event) => {
            if(event.http){

              let functionName = ""
              let sourceAccount = ""

              //Passando pelas funcoes para consegui o nome
              await asyncForEach(lambdaFunctions, async (lf) => {
              //lambdaFunctions.forEach(lf => {
                if(lf.functionKey.toLowerCase().includes(this.naming.normalizePath(fn).toLowerCase())){
                  functionName = lf.functionName
                  sourceAccount = lf.sourceAccount
                }
              })

              if(functionName == "" || sourceAccount == ""){
                throw new Error('Não foi possível definir o function name e/ou sourceAccount da função: ' + fn);
              }

              //Criando o sourceARN da funcao
              functionName = "arn:aws:lambda:" + this.serverless.service.provider.region + ":" + sourceAccount + ":function:" + functionName

              await this.lambda.updateAlias({
                FunctionName: functionName,
                FunctionVersion: '$LATEST',
                Name: this.serverless.service.provider.stage
              }).promise()
            }
          })
        })
      }
      await start()
    }
  }

  //Adicionando o swagger da api ao bucket
  async exportSwaggerToS3() {

    if(this.serverless.service.custom.documentation){

      const bucketDocumentationName = 'files-apigateway-documentation' + (this.serverless.service.provider.accountDeploy ? '-account-' + this.serverless.service.provider.accountDeploy : "")
      const fileNameJson =  this.apiName + "/" + this.apiName + "-" + this.serverless.service.provider.stage + ".json"
      const bucketDocumentationStatic = this.apiName.toLowerCase() + "-" + this.serverless.service.provider.stage + (this.serverless.service.provider.accountDeploy ? '-account-' + this.serverless.service.provider.accountDeploy : "") //bucket para aentrega do site estatico
      const fs = require("fs")
      const path = require("path")
      const{ execSync } = require('child_process')
      const contentType = require('./mime-types.js').ext

      let swaggerJsonFile = await this.apiGateway.getExport({
        "exportType": "swagger",
        "restApiId": this.api.id,
        "stageName": this.serverless.service.provider.stage
      }).promise()

      //Verificar se o bucker para armazenar o json existe
      try {
        await this.s3.headBucket({Bucket: bucketDocumentationName}).promise()
        this.serverless.cli.log('Bucket para armazenamento de documentações ja existe');
      //Não existe o bucket então criar
      }catch(e){
        await this.s3.createBucket({
          Bucket: bucketDocumentationName,
          ACL: "public-read"
        }).promise()

        //Adicionando o cors ao bucket para acesso do outro bucket
        await this.s3.putBucketCors({
          Bucket: bucketDocumentationName,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedHeaders: ["*"],
                AllowedMethods: ["GET"],
                AllowedOrigins: ["*"],
                MaxAgeSeconds: 3000
              },
            ]
          }
        }).promise()
      }

      //Adicionando o arquivo ao bucket
      await this.s3.putObject({
        Body: swaggerJsonFile.body,
        Bucket: bucketDocumentationName,
        Key: fileNameJson,
        ACL: 'public-read',
      }).promise()
    }
  }

  //Funcao para adicionar :${stageVariables.SERVERLESS_ALIAS} no metodo da api gateway para funcionar junto com o alias
  async addStageVariableApiFunction() {

    let resources = this.serverless.service.provider.compiledCloudFormationTemplate.Resources
    //throw new Error(JSON.stringify(this.serverless.service.provider.compiledCloudFormationTemplate))
    if(!(resources.hasOwnProperty('ApiGatewayRestApi'))){
      Object.keys(resources).forEach(r => {
        if(resources[r].Type == "AWS::ApiGateway::Method"){

          if(resources[r].Properties.Integration.hasOwnProperty('Uri')){
            resources[r].Properties.Integration.Uri['Fn::Join'][1].forEach( (value,i) => {
              if(value['Fn::GetAtt']){
                resources[r].Properties.Integration.Uri['Fn::Join'][1].splice(i + 1, 0, ':${stageVariables.SERVERLESS_ALIAS}')
              }
            })
          }
        }
      })
    }
  }

  async addRequestValidator(){
    let resources = this.serverless.service.provider.compiledCloudFormationTemplate.Resources
    const functions = this.serverless.service.functions
    this.moduloName

    const methods = Object.keys(resources).reduce((arr, key) => {
      if (resources[key].Type === 'AWS::ApiGateway::Method') {
        arr.push({ [key]: resources[key] })
      }
      return arr
    }, [])

    for (const functionName of Object.keys(functions)) {
      if(functions[functionName].events){
        for (const event of functions[functionName].events){
          if(event.http){
            if(event.http.requestValidator){
              const resourcesArray = event.http.path.split('/')
              const normalizedResourceName = resourcesArray.map((value) => this.naming.normalizePath(value)).join('')
              const methodName = `ApiGatewayMethod${normalizedResourceName}${this.naming.normalizePath(event.http.method)}`
              let method = methods.filter(method => methodName in method)

              if(method.length > 1){
                throw new Error(`Impossível a definição de 2 metodos http iguais: ${event.http.method} para a função ${functionName}`)
              }

              method = method[0]

              const requestValidator = event.http.requestValidator
              let requestValidatorId = {}

              // ja existe a api
              if(this.api){

                // resources
                const { items } = await this.apiGateway.getRequestValidators({restApiId: this.api.id}).promise()
                const validator = items.filter(validator => validator.name === requestValidator)

                //Configuração correta porem a criação não foi feita
                if(validator.length == 0 && (requestValidator === 'body' || requestValidator === 'body-and-params' || requestValidator === 'params')){
                  this.serverless.service.provider.compiledCloudFormationTemplate.Resources = Object.assign(this.serverless.service.provider.compiledCloudFormationTemplate.Resources,
                    {
                      "RequestValidatorBody": {
                        "Type": "AWS::ApiGateway::RequestValidator",
                        "Properties": {
                          "Name": "body",
                          "RestApiId": this.api.id,
                          "ValidateRequestBody": true,
                          "ValidateRequestParameters": false
                        }
                      },
                      "RequestValidatorParams": {
                        "Type": "AWS::ApiGateway::RequestValidator",
                        "Properties": {
                          "Name": "params",
                          "RestApiId": this.api.id,
                          "ValidateRequestBody": false,
                          "ValidateRequestParameters": true
                        }
                      },
                      "RequestValidatorBodyParams": {
                        "Type": "AWS::ApiGateway::RequestValidator",
                        "Properties": {
                          "Name": "body-and-params",
                          "RestApiId": this.api.id,
                          "ValidateRequestBody": true,
                          "ValidateRequestParameters": true
                        }
                      },
                    })

                    switch(requestValidator) {
                      case 'body':
                        requestValidatorId.Ref = "RequestValidatorBody"
                        break
                      case 'params':
                        requestValidatorId.Ref = "RequestValidatorBody"
                        break
                      case 'body-and-params':
                        requestValidatorId.Ref = "RequestValidatorBodyParams"
                        break
                      default:
                        throw new Error(`configuração incorreta para requestValidator para a função: ${functionName} no metodo http: ${event.http.method}`)
                    }
                }else{
                  if(validator.length != 1){
                    throw new Error(`configuração incorreta para requestValidator para a função: ${functionName} no metodo http: ${event.http.method}`)
                  }
                  requestValidatorId = validator[0].id
                }
              }else{

                switch(requestValidator) {
                  case 'body':
                    requestValidatorId.Ref = "RequestValidatorBody"
                    break
                  case 'params':
                    requestValidatorId.Ref = "RequestValidatorBody"
                    break
                  case 'body-and-params':
                    requestValidatorId.Ref = "RequestValidatorBodyParams"
                    break
                  default:
                    throw new Error(`configuração incorreta para requestValidator para a função: ${functionName} no metodo http: ${event.http.method}`)
                }
              }
              method[methodName].Properties.RequestValidatorId = requestValidatorId
            }
          }
        }
      }
    }
  }

  async manipulateDocumentation() {
    if(this.api && this.serverless.service.custom.documentation){
      let resources = this.serverless.service.provider.compiledCloudFormationTemplate.Resources
      //throw new Error(JSON.stringify(this.serverless.service.provider.compiledCloudFormationTemplate))

      //Verificando se os models definidos aqui ja existem na API
      if(this.serverless.service.custom.documentation.hasOwnProperty('models')){
        //conseguindo os models ja implementados
        const {items} = await this.apiGateway.getModels({
          "restApiId": this.api.id,
          limit: 500
        }).promise()

        let modelsRemovidos = []

        //Removendo os models ja criados em outra stack dessa mesma API
        Object.keys(resources).forEach(r => {
          if(resources[r].Type == "AWS::ApiGateway::Model"){
              if(items.some(e => e.name === resources[r].Properties.Name)){
                modelsRemovidos.push(r)
                delete resources[r]
              }
          }
        })

        //Removendo esse models do dependsOn dos methods
        Object.keys(resources).forEach(r => {
          if(resources[r].Type == "AWS::ApiGateway::Method"){
            //Caso ja exista o model eu removo ele do array de models
            if(resources[r].DependsOn){
              resources[r].DependsOn = resources[r].DependsOn.filter( model => {
                return !modelsRemovidos.some(e => e === model)
              })
            }
          }
        })
      }
    }
  }

  async createCustomDomain() {

    const service = this.serverless.service
    if (service.custom && service.custom.customDomain){

      this.initializeVariables()

      let domainName = service.custom.customDomain.domainName.toLowerCase()
      let endpointType = service.custom.customDomain.endpointType || service.provider.endpointType
      let certificateName = service.custom.customDomain.certificateName

      let cloudTemplate = this.serverless.service.provider.compiledCloudFormationTemplate

      if (!cloudTemplate.Outputs) {
        cloudTemplate.Outputs = {}
      }

      if (domainName == null || domainName.trim() === '') {
        throw new Error('Error: Favor configurar o domain name no serverless.yml')
      }

      if (endpointType == null || endpointType.trim() === '') {
        endpointType = 'EDGE'
      }

      //conseguindo todos os domains registrados
      let customDomainName = await this.apiGateway.getDomainNames({limit:1000}).promise()

      let existe = false

      //verificar se o custom domain registrado existe
      customDomainName.items.forEach( domain => {
        if(domain.domainName == domainName){
          existe = true
        }
      })

      //se nao existe entao eh necessario criar
      if(!existe){

        //Para criar necessito encontrar o certificado
        let certificados = (await this.acm.listCertificates({
          CertificateStatuses: ['PENDING_VALIDATION', 'ISSUED', 'INACTIVE']
        }).promise()).CertificateSummaryList

        let certificateArn = ""

        certificados.forEach(certificado => {
          //O certificado possui um dominio atrelado
          //esse dominio deve ser cadastrado anterior a essa operação
          if(certificado.DomainName == certificateName){
            certificateArn = certificado.CertificateArn
          }
        })

        if(certificateArn == ""){
          throw new Error("Certificado informado não encontrado")
        }

        //Defino as opcoes para a criacao do custom domain
        let createDomainNameParams = {
          domainName: domainName,
          endpointConfiguration: {
            types: [endpointType.toUpperCase()],
          },
        }

        if (endpointType.toLowerCase() === 'edge') {
          createDomainNameParams.certificateArn = certificateArn;
        } else {
          createDomainNameParams.regionalCertificateArn = certificateArn;
        }

        //crio o domain
        let newDomain = await this.apiGateway.createDomainName(createDomainNameParams).promise()

        //crio o A alias para o novo subdominio
        if (service.custom.customDomain.createRoute53Record) {

          //consigo o hostedZone do dominio principal
          const hostedZones = await this.route53.listHostedZones({}).promise()
          const hostedZoneEscolhida = hostedZones.HostedZones.filter((hz) => {
            return (hz.Name.endsWith('.') ? hz.Name.slice(0, -1) : hz.Name) == domainName.replace(this.apiName.toLowerCase()+'.','')
          })

          if(!hostedZoneEscolhida || hostedZoneEscolhida.length == 0){
            throw new Error('Não foi possível localizar o HostedZone do domínio: ' + domainName.replace(this.apiName.toLowerCase()+'.',''))
          }

          for (const hostedZone of hostedZoneEscolhida) {
            let hostedZoneId = hostedZone.Id
            const startPos = hostedZoneId.indexOf('e/') + 2
            const endPos = hostedZoneId.length
            hostedZoneId = hostedZoneId.substring(startPos, endPos)

            try {
              await this.route53.changeResourceRecordSets({
                ChangeBatch: {
                  Changes: [
                    {
                      Action: 'CREATE',
                      ResourceRecordSet: {
                        Name: domainName,
                        Type: 'A',
                        AliasTarget: {
                          DNSName: newDomain.distributionDomainName || newDomain.domainName,
                          EvaluateTargetHealth: false,
                          HostedZoneId: newDomain.distributionHostedZoneId || newDomain.hostedZoneId,
                        },
                      },
                    },
                  ],
                  Comment: 'CloudFront distribution for ' + domainName,
                },
                HostedZoneId: hostedZoneId
              }).promise()
            }catch(e) {
              throw new Error("Não foi possível criar o A alias para o subdomínio: " + e)
            }
          }
        }
      }
    }
  }

    //Verificando se ja existe o pathMapping no custom Domain, se nao existir sera criado agora
    async createBasePathMappings() {

      let service = this.serverless.service
  
      if (service.custom && service.custom.customDomain){
  
        this.initializeVariables()
        let domainName = service.custom.customDomain.domainName.toLowerCase()
        let basePath = service.custom.customDomain.basePath
  
        if (basePath == null || basePath.trim() === '') {
          throw new Error('Error: Favor configurar o base path para o domain no serverless.yml')
        }
  
        if (domainName == null || domainName.trim() === '') {
          throw new Error('Error: Favor configurar o domain name no serverless.yml')
        }
  
        //Verificando se ja existe esse base path definido para o custom domain
        let baseMappings = await this.apiGateway.getBasePathMappings({
          domainName: domainName,
          limit: 500
        }).promise()
  
        let baseMappingsCloudFormation = Object.keys(this.resourcesCloudFormation).reduce((arr, key) => {
          if (this.resourcesCloudFormation[key].Type === 'AWS::ApiGateway::BasePathMapping') {
            arr.push(this.resourcesCloudFormation[key])
          }
          return arr
        }, [])
  
        //Conseguindo o deployment ID
        const cloudTemplate = service.provider.compiledCloudFormationTemplate
  
        let deployId = Object.keys(cloudTemplate.Resources).find((key) => {
          const resource = cloudTemplate.Resources[key]
          return resource.Type === 'AWS::ApiGateway::Deployment'
        });
  
        if (!deployId) {
          throw new Error('não foi possível verificar o deployment AWS::ApiGateway::Deployment')
        }
  
        let dependsOn = [deployId]
  
        //add baseMapping added inside this cloudformation
        baseMappingsCloudFormation.forEach(bm => {
          bm.DependsOn = dependsOn
          cloudTemplate.Resources[`pathmapping${bm.Properties.BasePath}`] = bm
        })
  
        let existe = false
        //percorrendo todos os basemappings para verificar a existencia do fornecido
        if(baseMappings){
          if(baseMappings.items){
            baseMappings.items.forEach( bm => {
              if(bm.basePath == basePath && !baseMappingsCloudFormation.some(e => e.Properties.BasePath === bm.basePath)){
                existe = true
              }
            })
          }
        }
  
        //se nao existir, criar
        if(!existe){
          let stage = service.custom.customDomain.stage
  
          if (typeof stage === 'undefined') {
            stage = service.provider.stage
          }
  
          // se for definido o stage pelo usuario
          if (cloudTemplate.Resources.ApiGatewayStage) {
            dependsOn.push('ApiGatewayStage')
          }
  
          let apiGatewayRef = { Ref: 'ApiGatewayRestApi' }
  
          // Adicionando a referencia de uma api ja existente
          if (service.provider.apiGateway && service.provider.apiGateway.restApiId) {
            apiGatewayRef = service.provider.apiGateway.restApiId
          }
  
          // Criando o pathmapping
          const pathmapping = {
            Type: 'AWS::ApiGateway::BasePathMapping',
            DependsOn: dependsOn,
            Properties: {
              BasePath: basePath,
              DomainName: domainName,
              RestApiId: apiGatewayRef,
              Stage: stage
            }
          }
  
          // adiciona aos resources
          cloudTemplate.Resources[`pathmapping${basePath}`] = pathmapping
  
        }
      }
    }

  async createDocumentationPath(){

    const service = this.serverless.service
    if(service.custom && service.custom.documentation){
      let cloudTemplate = this.serverless.service.provider.compiledCloudFormationTemplate
      const docPath = service.custom.docPath || 'doc'

      if(this.apiResources &&
         this.apiResources.some( resource => resource.path === `/${docPath}`) &&
         !Object.keys(this.resourcesCloudFormation).some(keyResource => this.resourcesCloudFormation[keyResource].Properties.PathPart === docPath)
      ){
        this.serverless.cli.log('Path de documentação já criado')
        return
      }

      let functionARN
      try{
        const { Parameter } = await this.ssm.getParameter({Name: '/apiGatewayDocumentation/LAMBDA_ARN', WithDecryption: true}).promise()
        functionARN = Parameter.Value
      }catch (err) {
        this.serverless.cli.log('Favor verificar se o lambda responsável por gerar o embed da página de documentação existe');
        throw new Error(err)
      }

      let restApiId = {
        "Ref": "ApiGatewayRestApi"
      }

      let parentId = {
        "Fn::GetAtt": [
          "ApiGatewayRestApi",
          "RootResourceId"
        ]
      }

      if(this.api) {
        restApiId = this.api.id
        parentId = service.provider.apiGateway.restApiRootResourceId
      }

      const resource = {
        "ApiGatewayResourcePathDoc": {
          "Type": "AWS::ApiGateway::Resource",
          "Properties": {
            "ParentId": parentId,
            "PathPart": `${docPath}`,
            "RestApiId": restApiId
          }
        }
      }

      const method = {
        "ApiGatewayMethodDocGet": {
          "Type": "AWS::ApiGateway::Method",
          "Properties": {
            "HttpMethod": "GET",
            "RequestParameters": {},
            "ResourceId": {
              "Ref": "ApiGatewayResourcePathDoc"
            },
            "RestApiId": restApiId,
            "ApiKeyRequired": false,
            "AuthorizationType": "NONE",
            "Integration": {
              "IntegrationHttpMethod": "POST",
              "Type": "AWS_PROXY",
              "Uri": {
                "Fn::Join": [
                  "",
                  [
                    "arn:",
                    {
                      "Ref": "AWS::Partition"
                    },
                    ":apigateway:",
                    {
                      "Ref": "AWS::Region"
                    },
                    ":lambda:path/2015-03-31/functions/",
                    functionARN,
                    "/invocations"
                  ]
                ]
              }
            },
            "MethodResponses": []
          }
        }
      }

      const permission = {
        "PathDocLambdaPermissionApiGateway": {
          "Type": "AWS::Lambda::Permission",
          "Properties": {
            "FunctionName": functionARN.split(':').pop(),
            "Action": "lambda:InvokeFunction",
            "Principal": "apigateway.amazonaws.com",
            "SourceArn": {
              "Fn::Join": [
                "",
                [
                  "arn:",
                  {
                    "Ref": "AWS::Partition"
                  },
                  ":execute-api:",
                  {
                    "Ref": "AWS::Region"
                  },
                  ":",
                  {
                    "Ref": "AWS::AccountId"
                  },
                  ":",
                  restApiId,
                  "/*/*"
                ]
              ]
            }
          }
        }
      }

      Object.keys(cloudTemplate.Resources).forEach(key => {
        if(cloudTemplate.Resources[key].Type === 'AWS::ApiGateway::Deployment'){
          cloudTemplate.Resources[key].DependsOn.push(`ApiGatewayMethod${this.naming.normalizePath(docPath)}Get`)
        }
      })

      cloudTemplate.Resources = Object.assign(cloudTemplate.Resources, resource, method, permission)
    }
  }

  async createAuthorizer(){

    let service = this.serverless.service

    if (service.custom && service.custom.authorizerConfig){

      this.initializeVariables()

      let name = service.custom.authorizerConfig.name
      let arn = service.custom.authorizerConfig.arn
      let type = service.custom.authorizerConfig.type
      let identitySource = service.custom.authorizerConfig.identitySource

      if (name == null || name.trim() === '') {
        name = service.provider.apiName
      }

      if (arn == null || arn.trim() === '') {
        throw new Error('Error: Favor configurar o arn da função lambda utilizada como authorizer no serverless.yml')
      }

      //verificando se existe a função informada no ARN
      try {
        let lambdaName = arn.split(":")
        lambdaName = lambdaName[lambdaName.length-1]
        await this.lambda.getFunction({FunctionName: lambdaName}).promise()
      }catch(e){
        throw new Error('Error: O arn da função lambda utilizada como authorizer não existe')
      }

      if (type == null || type.trim() === '') {
        type = "REQUEST"
      }

      if (identitySource == null) {
        identitySource = ""
      }

      //conseguindo o cf para manipulacao
      let cloudTemplate = service.provider.compiledCloudFormationTemplate

      let authorizerId = {
        "Ref": "ApiGatewayAuthorizer"
      }

      let existsCreateAuthorizer = false
      let authorizers = []
      if(this.api){
        //consultando os authorizadores definidos para a api
        const {items} = await this.apiGateway.getAuthorizers({restApiId: this.api.id, limit: 500}).promise()
        authorizers = items.filter(e => e.name === name)
        existsCreateAuthorizer = authorizers.length > 0
      }

      //se existir referencia
      if(existsCreateAuthorizer){
        authorizerId = authorizers[0].id
      //senão cria
      }else{
        cloudTemplate.Resources = Object.assign(cloudTemplate.Resources,
          {
            "ApiGatewayAuthorizerLambdaPermissionApiGateway": {
              "Type": "AWS::Lambda::Permission",
              "Properties": {
                "FunctionName": {
                  "Fn::Sub": arn.replace(new RegExp('#','g'), '$')
                },
                "Action": "lambda:InvokeFunction",
                "Principal": {
                  "Fn::Join": [
                    "",
                    [
                      "apigateway.",
                      {
                        "Ref": "AWS::URLSuffix"
                      }
                    ]
                  ]
                }
              },
              "DependsOn": [
                "ApiGatewayAuthorizer"
              ]
            },
          })
      }

      const authorizerExecute = {
        ApiKeyRequired: false,
        AuthorizationType: "CUSTOM",
        AuthorizerId: authorizerId
      }

      //adicionando a permissao para executar o authorizer
      Object.keys(cloudTemplate.Resources).forEach((key) => {
        if(cloudTemplate.Resources[key].Type === 'AWS::ApiGateway::Method' && cloudTemplate.Resources[key].Properties.HttpMethod !== 'OPTIONS'){
          // adiciona as propriedades
          cloudTemplate.Resources[key].Properties = Object.assign(cloudTemplate.Resources[key].Properties, authorizerExecute)
        }
      })
    }
  }

  async addLambdaPermission(){

    const cfAliasTemplate = this.serverless.service.provider.compiledCloudFormationAliasTemplate.Resources
    const functions = this.serverless.service.functions

    //Preciso verificar se necessito criar as permissoes lambdas para os alias
    Object.keys(cfAliasTemplate).forEach (key => {
      if(cfAliasTemplate[key].Type == "AWS::Lambda::Alias"){

        let existePermission = false

        //Verifica se existe a permission no template
        Object.keys(cfAliasTemplate).forEach (keyPermission => {
          if(cfAliasTemplate[keyPermission].Type == "AWS::Lambda::Permission" && keyPermission == key.replace('Alias','') + 'LambdaPermissionApiGateway'){
            existePermission = true
          }
        })

        const funcKey = Object.keys(functions).filter(funcName => this.naming.normalizePath(funcName) === this.naming.normalizePath(key.replace('Alias','')))[0]

        //nao existe preciso adicionar
        if(!existePermission && functions[funcKey].events && functions[funcKey].events.some(func => func.http)){

          //Criando a dependencia da permissao
          let dependsOn = [key]
          dependsOn = dependsOn.concat(cfAliasTemplate[key].DependsOn)

          //Adicionando a permissão para a api executar essa função lambda
          this.serverless.service.provider.compiledCloudFormationAliasTemplate.Resources = Object.assign(this.serverless.service.provider.compiledCloudFormationAliasTemplate.Resources,
            {
              [key.replace('Alias','') + "LambdaPermissionApiGateway"]:{
                "Type":"AWS::Lambda::Permission",
                "Properties":{
                    "FunctionName":{
                      "Ref":key
                    },
                    "Action":"lambda:InvokeFunction",
                    "Principal":{
                      "Fn::Join":[
                          "",
                          [
                            "apigateway.",
                            {
                                "Ref":"AWS::URLSuffix"
                            }
                          ]
                      ]
                    },
                    "SourceArn":{
                      "Fn::Join":[
                          "",
                          [
                            "arn:",
                            {
                                "Ref":"AWS::Partition"
                            },
                            ":execute-api:",
                            {
                                "Ref":"AWS::Region"
                            },
                            ":",
                            {
                                "Ref":"AWS::AccountId"
                            },
                            ":",
                            this.api.id,
                            "/*/*"
                          ]
                      ]
                    }
                  },
                  "DependsOn":dependsOn
                }
              })
        }
      }
    })
  }
}

module.exports = ServerlessEngine;
